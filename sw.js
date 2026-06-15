const DB_NAME = "image_gen_history";
const DB_VERSION = 1;
const STORE_NAME = "generations";
const CHANNEL_NAME = "image_gen:generation-updates";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "image_gen:start-generation") {
    return;
  }

  const { generation, payload } = event.data;
  event.waitUntil(startGeneration(generation, payload));
});

async function startGeneration(generation, payload) {
  try {
    const response = await fetch("/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(getApiError(data));
    }

    const images = extractImages(data);
    const updated = {
      ...generation,
      remoteId: data.id || "",
      status: images.length > 0 || data.status === "completed"
        ? "completed"
        : normalizeStatus(data.status, data.id ? "pending" : "completed"),
      images,
      raw: data,
      error: "",
      updatedAt: new Date().toISOString()
    };

    await saveGeneration(updated);
    await broadcastGeneration(updated);
  } catch (error) {
    const failed = {
      ...generation,
      status: "failed",
      error: error.message || "Запрос не выполнен",
      updatedAt: new Date().toISOString()
    };

    await saveGeneration(failed);
    await broadcastGeneration(failed);
  }
}

async function broadcastGeneration(generation) {
  if ("BroadcastChannel" in self) {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage(generation);
    channel.close();
  }

  const clients = await self.clients.matchAll({
    includeUncontrolled: true,
    type: "window"
  });

  clients.forEach((client) => {
    client.postMessage({
      type: "image_gen:generation-updated",
      generation
    });
  });
}

async function saveGeneration(generation) {
  const db = await openDb();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.put(generation);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.onerror = () => reject(tx.error);
  });
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

function normalizeStatus(status, fallback) {
  return ["starting", "pending", "processing", "completed", "failed", "cancelled"].includes(status)
    ? status
    : fallback;
}

function getApiError(data) {
  return data?.details?.error?.message
    || data?.details?.message
    || data?.error?.message
    || data?.error
    || "Запрос не выполнен";
}
