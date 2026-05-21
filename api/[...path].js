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
  const functionUrl = process.env.SUPABASE_FUNCTION_URL;
  if (!functionUrl) {
    response.status(500).json({ error: "Missing SUPABASE_FUNCTION_URL." });
    return;
  }

  const path = Array.isArray(request.query.path) ? request.query.path.join("/") : "";
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
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-encoding") return;
    response.setHeader(key, value);
  });
  response.send(Buffer.from(await upstream.arrayBuffer()));
}
