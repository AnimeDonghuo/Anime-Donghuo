import { randomUUID } from 'node:crypto';

const IMGBB_UPLOAD_ENDPOINT = 'https://api.imgbb.com/1/upload';
const imageExtensions = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
});

export async function uploadImageToImgBB(bytes, contentType, apiKey, fetchImpl = fetch) {
  if (!apiKey) throw new Error('ImgBB uploads are not configured.');
  if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > 10 * 1024 * 1024) {
    throw new Error('Image size is invalid.');
  }
  const extension = imageExtensions[contentType];
  if (!extension) throw new Error('Only JPEG, PNG, and WebP images are supported.');

  const form = new FormData();
  form.append('image', new Blob([bytes], { type: contentType }), `anime-donghua-${randomUUID()}.${extension}`);
  const endpoint = new URL(IMGBB_UPLOAD_ENDPOINT);
  endpoint.searchParams.set('key', apiKey);

  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('The ImgBB upload request failed.');
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('ImgBB returned an unreadable response.');
  }
  if (!response.ok || payload?.success !== true || typeof payload?.data?.url !== 'string') {
    throw new Error('ImgBB did not accept the image.');
  }

  let imageUrl;
  try {
    imageUrl = new URL(payload.data.url);
  } catch {
    throw new Error('ImgBB returned an invalid image URL.');
  }
  if (imageUrl.protocol !== 'https:' || imageUrl.hostname !== 'i.ibb.co' || imageUrl.username || imageUrl.password || imageUrl.port) {
    throw new Error('ImgBB returned an untrusted image host.');
  }
  return imageUrl.href;
}
