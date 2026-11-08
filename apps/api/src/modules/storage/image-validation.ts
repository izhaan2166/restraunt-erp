export type ImageType = { ext: 'jpg' | 'png' | 'webp'; contentType: 'image/jpeg' | 'image/png' | 'image/webp' };

/**
 * Identifies an image by its magic bytes. The client's filename and Content-Type are ignored,
 * so a renamed executable or HTML file can never be stored as an "image".
 */
export function sniffImage(buf: Buffer): ImageType | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: 'jpg', contentType: 'image/jpeg' };
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buf.length >= 8 && png.every((b, i) => buf[i] === b)) return { ext: 'png', contentType: 'image/png' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return { ext: 'webp', contentType: 'image/webp' };
  }
  return null;
}

export type ReceiptType = ImageType | { ext: 'pdf'; contentType: 'application/pdf' };

/** Expense receipts: a photo (JPEG, PNG, WebP) or a PDF, identified by magic bytes. */
export function sniffReceipt(buf: Buffer): ReceiptType | null {
  if (buf.length >= 5 && buf.toString('ascii', 0, 5) === '%PDF-') return { ext: 'pdf', contentType: 'application/pdf' };
  return sniffImage(buf);
}
