const MAX_FILES_PER_KIND = 6;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.86;
const HISTORY_STORAGE_KEY = "image_gen:selectedGeneration";
const DB_NAME = "image_gen_history";
const DB_VERSION = 1;
const STORE_NAME = "generations";
const WORKER_CHANNEL_NAME = "image_gen:generation-updates";
const POLL_INTERVAL_MS = 4000;
const MODELS = new Set([
  "openai/gpt-5.4-image-2",
  "google/gemini-3.1-flash-image-preview"
]);

const state = {
  references: [],
  characters: [],
  history: [],
  pollTimers: new Map(),
  selectedLocalId: localStorage.getItem(HISTORY_STORAGE_KEY) || ""
};

const form = document.querySelector("#generatorForm");
const modelInput = document.querySelector("#model");
const modelPill = document.querySelector("#modelPill");
const promptInput = document.querySelector("#prompt");
const aspectRatioInput = document.querySelector("#aspectRatio");
const resolutionInput = document.querySelector("#imageResolution");
const countInput = document.querySelector("#count");
const preserveCharactersInput = document.querySelector("#preserveCharacters");
const useReferenceStyleInput = document.querySelector("#useReferenceStyle");
const generateButton = document.querySelector("#generateButton");
const clearButton = document.querySelector("#clearButton");
const statusTitle = document.querySelector("#statusTitle");
const statusBadge = document.querySelector("#statusBadge");
const emptyState = document.querySelector("#emptyState");
const resultGrid = document.querySelector("#resultGrid");
const debugBox = document.querySelector("#debugBox");
const historyList = document.querySelector("#historyList");
const historyCount = document.querySelector("#historyCount");

const inputs = {
  references: document.querySelector("#referencesInput"),
  characters: document.querySelector("#charactersInput")
};

const previews = {
  references: document.querySelector("#referencesPreview"),
  characters: document.querySelector("#charactersPreview")
};

init();

async function init() {
  registerWorker();
  bindEvents();
  bindWorkerUpdates();
  syncModelPill();
  state.history = await loadHistory();
  renderHistory();
  selectInitialGeneration();
  resumePendingGenerations();
}

function bindEvents() {
  document.querySelectorAll("[data-pick]").forEach((button) => {
    button.addEventListener("click", () => {
      inputs[button.dataset.pick].click();
    });
  });

  for (const [kind, input] of Object.entries(inputs)) {
    input.addEventListener("change", async () => {
      await addFiles(kind, Array.from(input.files || []));
      input.value = "";
    });
  }

  document.querySelectorAll(".dropzone").forEach((zone) => {
    const kind = zone.dataset.kind;

    zone.addEventListener("dragover", (event) => {
      event.preventDefault();
      zone.classList.add("is-dragover");
    });

    zone.addEventListener("dragleave", () => {
      zone.classList.remove("is-dragover");
    });

    zone.addEventListener("drop", async (event) => {
      event.preventDefault();
      zone.classList.remove("is-dragover");
      await addFiles(kind, Array.from(event.dataTransfer.files || []));
    });
  });

  modelInput.addEventListener("change", syncModelPill);
  clearButton.addEventListener("click", resetForm);
  form.addEventListener("submit", submitGeneration);
}

async function addFiles(kind, files) {
  const imageFiles = files.filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type));
  const room = MAX_FILES_PER_KIND - state[kind].length;
  const accepted = imageFiles.slice(0, Math.max(0, room));

  if (accepted.length === 0) {
    return;
  }

  setStatus("Готовлю изображения", "processing");

  try {
    for (const file of accepted) {
      const dataUrl = await resizeImage(file);
      state[kind].push({
        id: crypto.randomUUID(),
        name: file.name,
        dataUrl
      });
    }

    renderPreviews(kind);
    renderSelectedGeneration();
  } catch (error) {
    setStatus("Ошибка файла", "failed");
    showDebug(error.message);
  }
}

function renderPreviews(kind) {
  previews[kind].replaceChildren(
    ...state[kind].map((item) => {
      const card = document.createElement("div");
      card.className = "preview-card";

      const img = document.createElement("img");
      img.src = item.dataUrl;
      img.alt = item.name;

      const remove = document.createElement("button");
      remove.className = "remove-button";
      remove.type = "button";
      remove.setAttribute("aria-label", `Удалить ${item.name}`);
      remove.textContent = "x";
      remove.addEventListener("click", () => {
        state[kind] = state[kind].filter((image) => image.id !== item.id);
        renderPreviews(kind);
      });

      card.append(img, remove);
      return card;
    })
  );
}

function resetForm() {
  state.references = [];
  state.characters = [];
  form.reset();
  syncModelPill();
  renderPreviews("references");
  renderPreviews("characters");
  renderSelectedGeneration();
}

async function submitGeneration(event) {
  event.preventDefault();
  hideDebug();

  const prompt = promptInput.value.trim();
  if (!prompt) {
    setStatus("Введите сюжет", "failed");
    return;
  }

  const generation = {
    localId: crypto.randomUUID(),
    remoteId: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "starting",
    model: normalizeModel(modelInput.value),
    prompt,
    aspectRatio: aspectRatioInput.value,
    imageResolution: resolutionInput.value,
    count: toNumber(countInput.value, 1),
    referencesCount: state.references.length,
    charactersCount: state.characters.length,
    images: [],
    raw: null,
    error: ""
  };

  await saveGeneration(generation);
  upsertGeneration(generation);
  selectGeneration(generation.localId);
  setLaunching(true);

  try {
    const payload = {
      prompt,
      model: generation.model,
      aspectRatio: generation.aspectRatio,
      imageResolution: generation.imageResolution,
      count: generation.count,
      preserveCharacters: preserveCharactersInput.checked,
      useReferenceStyle: useReferenceStyleInput.checked,
      references: state.references.map(toPayloadImage),
      characters: state.characters.map(toPayloadImage)
    };

    const delegated = await sendGenerationToWorker(generation, payload);

    if (delegated) {
      return;
    }

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(getApiError(data));
    }

    const updated = {
      ...generation,
      remoteId: data.id || "",
      status: normalizeStatus(data.status, data.id ? "pending" : "completed"),
      images: extractImages(data),
      raw: data,
      updatedAt: new Date().toISOString()
    };

    if (updated.images.length > 0 || updated.status === "completed") {
      updated.status = "completed";
    }

    await saveGeneration(updated);
    upsertGeneration(updated);
    selectGeneration(updated.localId);

    if (isPending(updated)) {
      startPolling(updated);
    }
  } catch (error) {
    const failed = {
      ...generation,
      status: "failed",
      error: error.message || "Запрос не выполнен",
      updatedAt: new Date().toISOString()
    };

    await saveGeneration(failed);
    upsertGeneration(failed);
    selectGeneration(failed.localId);
  } finally {
    setLaunching(false);
  }
}

async function registerWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("/sw.js");
  } catch {
    // The page still works without the worker; it just cannot finish launch after a hard close.
  }
}

function bindWorkerUpdates() {
  if ("BroadcastChannel" in window) {
    const channel = new BroadcastChannel(WORKER_CHANNEL_NAME);
    channel.onmessage = (event) => {
      handleWorkerGeneration(event.data);
    };
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type === "image_gen:generation-updated") {
        handleWorkerGeneration(event.data.generation);
      }
    });
  }
}

async function sendGenerationToWorker(generation, payload) {
  if (!("serviceWorker" in navigator)) {
    return false;
  }

  try {
    const registration = await withTimeout(navigator.serviceWorker.ready, 1500);

    if (!registration) {
      return false;
    }

    const worker = navigator.serviceWorker.controller || registration.active;

    if (!worker) {
      return false;
    }

    worker.postMessage({
      type: "image_gen:start-generation",
      generation,
      payload
    });
    return true;
  } catch {
    return false;
  }
}

function withTimeout(promise, timeoutMs) {
  return Promise.race([
    promise,
    new Promise((resolve) => {
      window.setTimeout(() => resolve(null), timeoutMs);
    })
  ]);
}

function handleWorkerGeneration(generation) {
  if (!generation?.localId) {
    return;
  }

  upsertGeneration(generation);

  if (state.selectedLocalId === generation.localId) {
    renderSelectedGeneration();
  }

  if (isPending(generation)) {
    startPolling(generation);
  }

  setLaunching(false);
}

async function pollGeneration(localId) {
  const current = state.history.find((item) => item.localId === localId);

  if (!current?.remoteId || !isPending(current)) {
    stopPolling(localId);
    return;
  }

  try {
    const response = await fetch(`/api/status?id=${encodeURIComponent(current.remoteId)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(getApiError(data));
    }

    const images = extractImages(data);
    const updated = {
      ...current,
      status: normalizeStatus(data.status, current.status),
      images: images.length > 0 ? images : current.images,
      raw: data,
      error: "",
      updatedAt: new Date().toISOString()
    };

    if (updated.status === "completed" && updated.images.length === 0) {
      updated.status = "completed";
    }

    if (updated.status === "failed" || updated.status === "cancelled") {
      updated.error = JSON.stringify(data.error || data, null, 2);
      stopPolling(localId);
    }

    if (updated.status === "completed") {
      stopPolling(localId);
    }

    await saveGeneration(updated);
    upsertGeneration(updated);
    renderSelectedGeneration();
  } catch (error) {
    const updated = {
      ...current,
      status: "pending",
      error: error.message || "Не удалось проверить статус",
      updatedAt: new Date().toISOString()
    };

    await saveGeneration(updated);
    upsertGeneration(updated);
    renderSelectedGeneration();
  }
}

function startPolling(generation) {
  if (!generation.remoteId || state.pollTimers.has(generation.localId)) {
    return;
  }

  const timer = window.setInterval(() => {
    pollGeneration(generation.localId);
  }, POLL_INTERVAL_MS);

  state.pollTimers.set(generation.localId, timer);
  pollGeneration(generation.localId);
}

function stopPolling(localId) {
  const timer = state.pollTimers.get(localId);

  if (!timer) {
    return;
  }

  window.clearInterval(timer);
  state.pollTimers.delete(localId);
}

function resumePendingGenerations() {
  state.history.filter(isPending).forEach(startPolling);
}

function selectInitialGeneration() {
  const remembered = state.history.find((item) => item.localId === state.selectedLocalId);
  const first = remembered || state.history[0];

  if (first) {
    selectGeneration(first.localId);
    return;
  }

  showEmpty("Здесь появятся готовые изображения.");
  setStatus("Готов к генерации", "idle");
}

function selectGeneration(localId) {
  state.selectedLocalId = localId;
  localStorage.setItem(HISTORY_STORAGE_KEY, localId);
  renderHistory();
  renderSelectedGeneration();
}

function renderSelectedGeneration() {
  const generation = state.history.find((item) => item.localId === state.selectedLocalId);

  if (!generation) {
    showEmpty("Здесь появятся готовые изображения.");
    setStatus("Готов к генерации", "idle");
    return;
  }

  setStatus(statusText(generation.status), generation.status);

  if (generation.images.length > 0) {
    renderResults(generation.images, generation);
    return;
  }

  showEmpty(emptyText(generation));

  if (generation.error) {
    showDebug(generation.error);
  }
}

function renderHistory() {
  historyCount.textContent = String(state.history.length);

  if (state.history.length === 0) {
    historyList.replaceChildren(createHistoryEmpty());
    return;
  }

  historyList.replaceChildren(
    ...state.history.map((generation) => {
      const button = document.createElement("button");
      button.className = "history-item";
      button.type = "button";
      button.dataset.status = generation.status;
      button.setAttribute("aria-current", generation.localId === state.selectedLocalId ? "true" : "false");
      button.addEventListener("click", () => selectGeneration(generation.localId));

      const thumb = document.createElement("div");
      thumb.className = "history-thumb";

      if (generation.images[0]) {
        const image = document.createElement("img");
        image.src = generation.images[0];
        image.alt = "";
        thumb.append(image);
      } else {
        thumb.textContent = statusShort(generation.status);
      }

      const body = document.createElement("div");
      body.className = "history-body";

      const top = document.createElement("div");
      top.className = "history-meta";
      top.textContent = `${formatDate(generation.createdAt)} · ${modelLabel(generation.model)}`;

      const prompt = document.createElement("div");
      prompt.className = "history-prompt";
      prompt.textContent = generation.prompt;

      const bottom = document.createElement("div");
      bottom.className = "history-status";
      bottom.textContent = `${statusText(generation.status)} · ${generation.images.length || generation.count} шт.`;

      body.append(top, prompt, bottom);
      button.append(thumb, body);
      return button;
    })
  );
}

function createHistoryEmpty() {
  const empty = document.createElement("div");
  empty.className = "history-empty";
  empty.textContent = "История появится после первой генерации.";
  return empty;
}

function renderResults(images, generation) {
  hideDebug();
  emptyState.hidden = true;
  resultGrid.hidden = false;
  resultGrid.replaceChildren(
    ...images.map((src, index) => {
      const card = document.createElement("article");
      card.className = "result-card";

      const img = document.createElement("img");
      img.src = src;
      img.alt = `Сгенерированное изображение ${index + 1}`;

      const actions = document.createElement("div");
      actions.className = "result-actions";

      const link = document.createElement("a");
      link.href = src;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Открыть";

      const download = document.createElement("a");
      download.href = src;
      download.download = `image_gen-${generation.localId}-${index + 1}.png`;
      download.textContent = "Скачать";

      actions.append(link, download);
      card.append(img, actions);
      return card;
    })
  );
}

function showEmpty(text) {
  resultGrid.hidden = true;
  resultGrid.replaceChildren();
  emptyState.hidden = false;
  emptyState.querySelector("p").textContent = text;
  hideDebug();
}

function resizeImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(img.width, img.height));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");

        canvas.width = width;
        canvas.height = height;

        const outputType = file.type === "image/png" && file.size < 800_000
          ? "image/png"
          : "image/jpeg";

        if (outputType === "image/jpeg") {
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, width, height);
        }

        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL(outputType, JPEG_QUALITY));
      };
      img.onerror = () => reject(new Error("Не удалось прочитать изображение"));
      img.src = reader.result;
    };

    reader.onerror = () => reject(new Error("Не удалось открыть файл"));
    reader.readAsDataURL(file);
  });
}

function toPayloadImage(item) {
  return {
    name: item.name,
    dataUrl: item.dataUrl
  };
}

function extractImages(payload) {
  const found = new Set();
  const images = [];

  visit(payload);
  return images;

  function add(value) {
    if (typeof value !== "string" || found.has(value)) {
      return;
    }

    const isDataImage = value.startsWith("data:image/");
    const isBase64 = /^[A-Za-z0-9+/=]{160,}$/.test(value) && !value.startsWith("http");
    const isUrl = /^https?:\/\//i.test(value);

    if (!isDataImage && !isBase64 && !isUrl) {
      return;
    }

    found.add(value);
    images.push(isBase64 ? `data:image/png;base64,${value}` : value);
  }

  function visit(node) {
    if (!node) {
      return;
    }

    if (typeof node === "string") {
      add(node);
      return;
    }

    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }

    if (typeof node === "object") {
      add(node.url);
      add(node.image_url);
      add(node.data_url);
      add(node.b64_json);
      add(typeof node.data === "string" ? node.data : "");
      Object.values(node).forEach(visit);
    }
  }
}

async function loadHistory() {
  const all = await idbGetAll();
  return all.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

async function saveGeneration(generation) {
  await idbPut(generation);
}

function upsertGeneration(generation) {
  const index = state.history.findIndex((item) => item.localId === generation.localId);

  if (index >= 0) {
    state.history[index] = generation;
  } else {
    state.history.unshift(generation);
  }

  state.history.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderHistory();
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "localId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function idbGetAll() {
  try {
    const db = await openDb();
    return await transaction(db, "readonly", (store, resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  } catch {
    return [];
  }
}

async function idbPut(value) {
  const db = await openDb();
  return transaction(db, "readwrite", (store, resolve, reject) => {
    const request = store.put(value);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

function transaction(db, mode, run) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    run(store, resolve, reject);
    tx.onerror = () => reject(tx.error);
  });
}

function setLaunching(isLaunching) {
  generateButton.disabled = isLaunching;
  generateButton.textContent = isLaunching ? "Запускаю..." : "Сгенерировать";
}

function setStatus(title, status) {
  statusTitle.textContent = title;
  statusBadge.textContent = status || "idle";
  statusBadge.classList.toggle("is-active", ["starting", "pending", "processing", "completed"].includes(status));
  statusBadge.classList.toggle("is-error", ["failed", "cancelled"].includes(status));
}

function statusText(status) {
  return {
    starting: "Запускается",
    pending: "Генерация в очереди",
    processing: "Генерация выполняется",
    completed: "Готово",
    failed: "Ошибка",
    cancelled: "Отменено"
  }[status] || "Готов к генерации";
}

function statusShort(status) {
  return {
    starting: "...",
    pending: "wait",
    processing: "run",
    completed: "ok",
    failed: "err",
    cancelled: "stop"
  }[status] || "new";
}

function normalizeStatus(status, fallback) {
  return ["starting", "pending", "processing", "completed", "failed", "cancelled"].includes(status)
    ? status
    : fallback;
}

function isPending(generation) {
  return ["starting", "pending", "processing"].includes(generation.status);
}

function emptyText(generation) {
  if (generation.status === "starting") {
    return "Задача создана и отправляется в Polza.";
  }

  if (generation.status === "pending" || generation.status === "processing") {
    return "Можно закрыть окно: эта задача сохранена в истории и продолжит проверяться при следующем открытии.";
  }

  if (generation.status === "failed") {
    return "Генерация завершилась ошибкой.";
  }

  return "Для этой генерации пока нет изображений.";
}

function showDebug(text) {
  debugBox.hidden = false;
  debugBox.textContent = text;
}

function hideDebug() {
  debugBox.hidden = true;
  debugBox.textContent = "";
}

function getApiError(data) {
  return data?.details?.error?.message
    || data?.details?.message
    || data?.error?.message
    || data?.error
    || "Запрос не выполнен";
}

function syncModelPill() {
  modelInput.value = normalizeModel(modelInput.value);
  modelPill.textContent = modelInput.value;
}

function normalizeModel(value) {
  return MODELS.has(value) ? value : "openai/gpt-5.4-image-2";
}

function modelLabel(value) {
  if (value.startsWith("google/")) {
    return "Gemini";
  }

  return "GPT image";
}

function formatDate(value) {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function toNumber(value, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isNaN(number) ? fallback : Math.min(4, Math.max(1, number));
}
