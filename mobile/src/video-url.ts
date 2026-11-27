/** URL-only intake. Never fetches/resolves remote pages or infers video content. */
export function videoUrl(raw: string): string {
  const text = raw.trim();
  if (text.length > 4096) throw new Error('Paste a single Instagram or TikTok video link.');
  const matches = text.match(/https:\/\/[^\s<>]+/g) ?? [];
  if (matches.length !== 1) throw new Error('Paste a single Instagram or TikTok video link.');
  const u = new URL(matches[0]);
  if (u.username || u.password || u.port || u.protocol !== 'https:') throw new Error('Unsupported video link.');
  const host = u.hostname.toLowerCase();
  let m: RegExpMatchArray | null;
  if (['instagram.com', 'www.instagram.com'].includes(host) && (m = u.pathname.match(/^\/(?:reel|reels|p)\/([A-Za-z0-9_-]+)\/?$/)))
    return `https://www.instagram.com/reel/${m[1]}/`;
  if (['tiktok.com', 'www.tiktok.com'].includes(host) && (m = u.pathname.match(/^\/(@[A-Za-z0-9._-]+)\/video\/([0-9]+)\/?$/)))
    return `https://www.tiktok.com/${m[1]}/video/${m[2]}`;
  if (['vm.tiktok.com', 'vt.tiktok.com'].includes(host) && (m = u.pathname.match(/^\/([A-Za-z0-9]+)\/?$/)))
    return `https://${host}/${m[1]}/`;
  throw new Error('Use an Instagram post/Reel or a TikTok video/share link. Profiles and other links aren’t supported.');
}
