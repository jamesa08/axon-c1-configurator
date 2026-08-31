const BASE = "/api";

async function req(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const api = {
  listDevices: () => req("GET", "/devices"),
  addDevice: (ip) => req("POST", "/device", { ip }),
  discover: (ip) => req("GET", `/device/${ip}/discover`),
  sendCmd: (ip, cmd) => req("POST", `/device/${ip}/cmd`, { cmd }),
  setSV: (ip, channel, db) => req("POST", `/device/${ip}/sv`, { channel, db }),
};
