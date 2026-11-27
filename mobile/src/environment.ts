/** Internal-test HTTP is limited to loopback/private LAN addresses, never public hosts. */
export function localTestHost(host: string) {
  if (host === 'localhost' || host === '[::1]') return true;
  const p=host.split('.').map(Number);
  if (p.length!==4 || p.some(x=>!Number.isInteger(x)||x<0||x>255)) return false;
  return p[0]===127 || p[0]===10 || p[0]===192 && p[1]===168 || p[0]===172 && p[1]>=16 && p[1]<=31;
}
