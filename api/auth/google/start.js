const pipeUpstream = async (request, response, targetPath) => {
  const functionUrl = process.env.SUPABASE_FUNCTION_URL || "https://nsysrnnnbvodxgoooyoj.supabase.co/functions/v1/asr-api";
  const requestUrl = new URL(request.url, `https://${request.headers.host || "localhost"}`);
  const target = new URL(`${functionUrl.replace(/\/$/, "")}${targetPath}`);
  requestUrl.searchParams.forEach((value, key) => target.searchParams.append(key, value));

  const headers = { ...request.headers };
  delete headers.host;
  delete headers["content-length"];
  headers["x-asr-origin"] = requestUrl.origin;

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    redirect: "manual",
  });

  response.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    if (key.toLowerCase() === "content-encoding") return;
    response.setHeader(key, value);
  });
  response.send(Buffer.from(await upstream.arrayBuffer()));
};

export default async function handler(request, response) {
  return pipeUpstream(request, response, "/api/auth/google/start");
}
