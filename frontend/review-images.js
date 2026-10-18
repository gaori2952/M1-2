const DB_NAME = "content-image-reviews";

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("assets");
      request.result.createObjectStore("sessions");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(
        new Error(
          "이미지 보관함을 열지 못했어요. 브라우저 저장 설정을 확인하세요.",
        ),
      );
    request.onblocked = () =>
      reject(new Error("다른 탭을 닫고 다시 시도해 주세요."));
  });
}

async function transaction(store, mode, operation) {
  const db = await openDB();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = operation(tx.objectStore(store));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = tx.onabort = () =>
        reject(
          new Error(
            "브라우저 저장 공간이 부족하거나 저장이 차단됐어요. 이전 검토에서 저장 상태를 확인해 주세요.",
          ),
        );
    });
  } finally {
    db.close();
  }
}

export async function putImages(uid, assets) {
  return transaction("assets", "readwrite", (store) => {
    for (const asset of assets) store.put(asset, `${uid}:${asset.sha256}`);
  });
}
export function getImage(uid, hash) {
  return transaction("assets", "readonly", (store) =>
    store.get(`${uid}:${hash}`),
  );
}
export function saveReviewSession(uid, session) {
  return transaction("sessions", "readwrite", (store) =>
    store.put(session, uid),
  );
}
export function getReviewSession(uid) {
  return transaction("sessions", "readonly", (store) => store.get(uid));
}

function dataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("이미지를 읽지 못했어요."));
    reader.readAsDataURL(blob);
  });
}

function isAnimated(bytes, mime) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png") {
    for (let i = 8; i + 12 <= bytes.length;) {
      const length = view.getUint32(i);
      const tag = String.fromCharCode(...bytes.slice(i + 4, i + 8));
      if (tag === "acTL") return true;
      i += length + 12;
    }
  }
  if (mime === "image/webp") {
    for (let i = 12; i + 8 <= bytes.length;) {
      const length = view.getUint32(i + 4, true);
      if (String.fromCharCode(...bytes.slice(i, i + 4)) === "ANIM") return true;
      i += 8 + length + (length % 2);
    }
  }
  return false;
}

export async function prepareFile(file) {
  if (!file.size || file.size > 10 * 1024 * 1024)
    throw new Error(`${file.name}: 원본은 10MB 이하로 선택해 주세요.`);
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type))
    throw new Error(`${file.name}: PNG·JPEG·WebP 이미지만 사용할 수 있어요.`);
  const source = new Uint8Array(await file.arrayBuffer());
  const signature =
    source.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10"
      ? "image/png"
      : source[0] === 255 && source[1] === 216 && source[2] === 255
        ? "image/jpeg"
        : String.fromCharCode(...source.slice(0, 4)) === "RIFF" &&
            String.fromCharCode(...source.slice(8, 12)) === "WEBP"
          ? "image/webp"
          : null;
  if (signature !== file.type)
    throw new Error(`${file.name}: 실제 이미지 형식이 파일 종류와 달라요.`);
  if (isAnimated(source, file.type))
    throw new Error(`${file.name}: 움직이는 이미지는 지원하지 않아요.`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`${file.name}: 이미지가 손상됐거나 읽을 수 없어요.`);
  }
  try {
    if (bitmap.width * bitmap.height > 40_000_000)
      throw new Error(
        `${file.name}: 원본 해상도를 4천만 화소 이하로 줄여 주세요.`,
      );
    const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let blob = await new Promise((resolve) =>
      canvas.toBlob(resolve, "image/png"),
    );
    for (const quality of [0.94, 0.84, 0.72]) {
      if (blob && blob.size <= 1_048_576) break;
      blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/jpeg", quality),
      );
    }
    if (!blob || blob.size > 1_048_576)
      throw new Error(
        `${file.name}: 글자가 선명한 상태로 1MB 이하가 되도록 이미지를 나누거나 줄여 주세요.`,
      );
    const bytes = await blob.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return {
      name: file.name.slice(0, 200),
      sha256: [...new Uint8Array(hash)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(""),
      mime: blob.type,
      base64: (await dataURL(blob)).split(",")[1],
      blob,
      original: file,
    };
  } finally {
    bitmap.close();
  }
}
