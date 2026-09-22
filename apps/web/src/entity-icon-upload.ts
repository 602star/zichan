import { MAX_ENTITY_ICON_LENGTH } from '@zichan/core';

export async function readEntityIcon(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPG 或 WebP 图片');
  if (file.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MB');
  const image = await createImageBitmap(file).catch(() => { throw new Error('无法读取这张图片，请换一张'); });
  try {
    if (!image.width || !image.height || image.width * image.height > 40_000_000) throw new Error('图片尺寸过大，请先缩小');
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 128;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片');
    const scale = Math.min(128 / image.width, 128 / image.height);
    const width = image.width * scale; const height = image.height * scale;
    context.drawImage(image, (128 - width) / 2, (128 - height) / 2, width, height);
    const result = canvas.toDataURL('image/webp', 0.82);
    if (result.length > MAX_ENTITY_ICON_LENGTH) throw new Error('图片细节过多，请使用更简单的图标');
    return result;
  } finally { image.close(); }
}
