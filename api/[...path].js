export const config = {
  api: {
    bodyParser: false,
  },
};

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};

export default async function handler(request, response) {
  const functionUrl = process.env.SUPABASE_FUNCTION_URL || "https://nsysrnnnbvodxgoooyoj.supabase.co/functions/v1/asr-api";
  const requestUrl = new URL(request.url, `https://${request.headers.host || "localhost"}`);
  const path = requestUrl.pathname.replace(/^\/api\/?/, "");
  const target = new URL(`${functionUrl.replace(/\/$/, "")}/api/${path}`);
  for (const [key, value] of Object.entries(request.query)) {
    if (key === "path") continue;
    if (Array.isArray(value)) value.forEach((item) => target.searchParams.append(key, item));
    else if (value !== undefined) target.searchParams.set(key, value);
  }

  const headers = { ...request.headers };
  delete headers.host;
  delete headers["content-length"];

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body: ["GET", "HEAD"].includes(request.method || "") ? undefined : await readBody(request),
    redirect: "manual",
  });

  response.status(upstream.status);
  const setCookies = typeof upstream.headers.getSetCookie === "function" ? upstream.headers.getSetCookie() : [];
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-encoding") return;
    if (key.toLowerCase() === "set-cookie" && setCookies.length) return;
    response.setHeader(key, value);
  });
  if (setCookies.length) response.setHeader("set-cookie", setCookies);
  response.send(Buffer.from(await upstream.arrayBuffer()));
}
