export async function autoVerify(type, data) {
    switch (type) {
        case "http-ping": {
            const endpointUrl = typeof data.endpoint_url === "string" ? data.endpoint_url : "";
            if (!endpointUrl) {
                return { success: false, details: "Missing endpoint_url for http-ping" };
            }
            const headers = {};
            const authType = typeof data.auth_type === "string" ? data.auth_type : "";
            const authValue = typeof data.auth_value === "string" ? data.auth_value : "";
            const authHeader = typeof data.auth_header === "string" ? data.auth_header : "";
            if (authValue) {
                if (authType === "bearer") {
                    headers.Authorization = `Bearer ${authValue}`;
                }
                else if (authType === "basic") {
                    headers.Authorization = `Basic ${authValue}`;
                }
                else if (authType === "api-key") {
                    headers["x-api-key"] = authValue;
                }
                else if (authType === "header" && authHeader) {
                    headers[authHeader] = authValue;
                }
            }
            try {
                const response = await fetch(endpointUrl, {
                    method: "GET",
                    headers,
                    signal: AbortSignal.timeout(10_000),
                });
                const code = response.status;
                if ((code >= 200 && code < 300) || code === 401 || code === 403 || code === 404) {
                    return { success: true, details: `Endpoint reachable with status ${code}` };
                }
                if (code >= 500) {
                    return { success: false, details: `Endpoint returned server error ${code}` };
                }
                return { success: true, details: `Endpoint reachable with status ${code}` };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                return { success: false, details: `HTTP ping failed: ${message}` };
            }
        }
        case "download-check": {
            const downloadUrl = typeof data.download_url === "string" ? data.download_url : "";
            const format = typeof data.format === "string" ? data.format.toLowerCase() : "";
            if (!downloadUrl) {
                return { success: false, details: "Missing download_url for download-check" };
            }
            try {
                const response = await fetch(downloadUrl, {
                    method: "HEAD",
                    signal: AbortSignal.timeout(10_000),
                });
                if (!response.ok) {
                    return { success: false, details: `HEAD request failed with status ${response.status}` };
                }
                const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
                const contentLengthHeader = response.headers.get("content-length");
                const contentLength = contentLengthHeader ? Number(contentLengthHeader) : NaN;
                const hasKnownType = !format || contentType.includes(format);
                const hasPositiveLength = Number.isFinite(contentLength) ? contentLength > 0 : true;
                if (!hasKnownType) {
                    return { success: false, details: `Content-Type mismatch for format '${format}': ${contentType || "missing"}` };
                }
                if (!hasPositiveLength) {
                    return { success: false, details: "Content-Length is zero" };
                }
                return {
                    success: true,
                    details: `Download endpoint reachable (${contentType || "unknown type"}, length=${contentLengthHeader ?? "unknown"})`,
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                return { success: false, details: `Download check failed: ${message}` };
            }
        }
        default:
            return { success: true, details: "No auto-verification available for this type" };
    }
}
