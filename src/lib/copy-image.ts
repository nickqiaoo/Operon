/** Copy the full image as PNG, independently of the preview's zoom or crop. */
async function imagePng(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("Unable to load image");
  const blob = await response.blob();
  if (blob.type === "image/png") return blob;

  // Clipboard APIs consistently support PNG. Decode other formats from a local
  // blob so drawing an attachment served by another port does not taint canvas.
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Unable to convert image");
    context.drawImage(image, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Unable to convert image")), "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function copyImageToClipboard(src: string): Promise<void> {
  const nativeCopy = window.electronAPI?.browser?.screenshotToClipboard;
  if (nativeCopy) {
    const png = await imagePng(src);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Unable to read image"));
      reader.onerror = () => reject(new Error("Unable to read image"));
      reader.readAsDataURL(png);
    });
    if (!await nativeCopy(dataUrl)) throw new Error("Unable to copy image");
    return;
  }

  if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
    throw new Error("Image clipboard is unavailable");
  }
  // Start the write during the click gesture, even while image conversion is
  // pending; Safari requires this to preserve clipboard permission.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": imagePng(src) })]);
}
