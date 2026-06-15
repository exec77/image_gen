const MAX_FILES_PER_KIND = 6;
const MAX_IMAGE_EDGE = 1600;
const JPEG_QUALITY = 0.86;

const state = {
  references: [],
  characters: [],
  pollTimer: null,
  pollingStartedAt: 0
};

const form = document.querySelector("#generatorForm");
const promptInput = document.querySelector("#prompt");
const aspectRatioInput = document.querySelector("#aspectRatio");
const resolutionInput = document.querySelector("#imageResolution");
const countInput = document.querySelector("#count");
const providerInput = document.querySelector("#provider");
const preserveCharactersInput = document.querySelector("#preserveCharacters");
const useReferenceStyleInput = document.querySelector("#useReferenceStyle");
const generateButton = document.querySelector("#generateButton");
const clearButton = document.querySelector("#clearButton");
const statusTitle = document.querySelector("#statusTitle");
const statusBadge = document.querySelector("#statusBadge");
const emptyState = document.querySelector("#emptyState");
const resultGrid = document.querySelector("#resultGrid");
const debugBox = document.querySelector("#debugBox");

const inputs = {
  references: document.querySelector("#referencesInput"),
  characters: document.querySelector("#charactersInput")
};

const previews = {
  references: document.querySelector("#referencesPreview"),
  characters: document.querySelector("#charactersPreview")
};

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

providerInput.addEventListener("change", syncProviderOptions);

clearButton.addEventListener("click", () => {
  stopPolling();
  state.references = [];
  state.characters = [];
  form.reset();
  syncProviderOptions();
  renderPreviews("references");
  renderPreviews("characters");
  setStatus("Готов к генерации", "idle");
  showEmpty();
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  stopPolling();
  setBusy(true);
  setStatus("Отправляю запрос", "pending");
  hideDebug();

  try {
    const payload = {
      prompt: promptInput.value,
      aspectRatio: aspectRatioInput.value,
      imageResolution: resolutionInput.value,
      count: countInput.value,
      provider: providerInput.value,
      preserveCharacters: preserveCharactersInput.checked,
      useReferenceStyle: useReferenceStyleInput.checked,
      references: state.references.map(toPayloadImage),
      characters: state.characters.map(toPayloadImage)
    };

    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(getApiError(data));
    }

    handleGenerationResponse(data);
  } catch (error) {
    setBusy(false);
    setStatus("Ошибка", "failed");
    showDebug(error.message);
  }
});

syncProviderOptions();

async function addFiles(kind, files) {
  const imageFiles = files.filter((file) => /^image\/(png|jpe?g|webp)$/i.test(file.type));
  const room = MAX_FILES_PER_KIND - state[kind].length;
  const accepted = imageFiles.slice(0, Math.max(0, room));

  if (accepted.length === 0) {
    return;
  }

  setStatus("Готовлю изображения", "processing");

  for (const file of accepted) {
    const dataUrl = await resizeImage(file);
    state[kind].push({
      id: crypto.randomUUID(),
      name: file.name,
      dataUrl
    });
  }

  renderPreviews(kind);
  setStatus("Готов к генерации", "idle");
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

function handleGenerationResponse(data) {
  const images = extractImages(data);

  if (images.length > 0 || data.status === "completed") {
    setBusy(false);
    setStatus("Готово", "completed");
    renderResults(images, data);
    return;
  }

  if (data.id) {
    setStatus("Генерация в очереди", data.status || "pending");
    state.pollingStartedAt = Date.now();
    state.pollTimer = window.setInterval(() => pollStatus(data.id), 4000);
    pollStatus(data.id);
    return;
  }

  setBusy(false);
  setStatus("Ответ получен", "completed");
  showDebug(JSON.stringify(data, null, 2));
}

async function pollStatus(id) {
  if (Date.now() - state.pollingStartedAt > 5 * 60 * 1000) {
    stopPolling();
    setBusy(false);
    setStatus("Превышено время ожидания", "failed");
    return;
  }

  try {
    const response = await fetch(`/api/status?id=${encodeURIComponent(id)}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(getApiError(data));
    }

    setStatus(statusText(data.status), data.status);

    if (data.status === "completed") {
      stopPolling();
      setBusy(false);
      renderResults(extractImages(data), data);
    }

    if (data.status === "failed" || data.status === "cancelled") {
      stopPolling();
      setBusy(false);
      showDebug(JSON.stringify(data.error || data, null, 2));
    }
  } catch (error) {
    stopPolling();
    setBusy(false);
    setStatus("Ошибка", "failed");
    showDebug(error.message);
  }
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

function renderResults(images, raw) {
  if (images.length === 0) {
    showEmpty();
    showDebug(JSON.stringify(raw, null, 2));
    return;
  }

  emptyState.hidden = true;
  resultGrid.hidden = false;
  resultGrid.replaceChildren(
    ...images.map((src, index) => {
      const card = document.createElement("article");
      card.className = "result-card";

      const img = document.createElement("img");
      img.src = src;
      img.alt = `Сгенерированное изображение ${index + 1}`;

      const link = document.createElement("a");
      link.href = src;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = "Открыть изображение";

      card.append(img, link);
      return card;
    })
  );
}

function showEmpty() {
  resultGrid.hidden = true;
  resultGrid.replaceChildren();
  emptyState.hidden = false;
  hideDebug();
}

function setBusy(isBusy) {
  generateButton.disabled = isBusy;
  generateButton.textContent = isBusy ? "Генерирую..." : "Сгенерировать";
}

function setStatus(title, status) {
  statusTitle.textContent = title;
  statusBadge.textContent = status || "idle";
  statusBadge.classList.toggle("is-active", ["pending", "processing", "completed"].includes(status));
  statusBadge.classList.toggle("is-error", ["failed", "cancelled"].includes(status));
}

function statusText(status) {
  return {
    pending: "Генерация в очереди",
    processing: "Генерация выполняется",
    completed: "Готово",
    failed: "Ошибка",
    cancelled: "Отменено"
  }[status] || "Проверяю статус";
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

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function syncProviderOptions() {
  const isMie = providerInput.value === "mie";
  const option4k = resolutionInput.querySelector('option[value="4K"]');
  const mieDisabledRatios = new Set(["2:3", "3:2", "4:5", "5:4", "21:9"]);

  option4k.disabled = !isMie;

  if (!isMie && resolutionInput.value === "4K") {
    resolutionInput.value = "2K";
  }

  for (const option of aspectRatioInput.options) {
    option.disabled = isMie && mieDisabledRatios.has(option.value);
  }

  if (aspectRatioInput.selectedOptions[0]?.disabled) {
    aspectRatioInput.value = "auto";
  }
}
