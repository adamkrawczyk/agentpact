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
        // ── Task-contract verifiers (data-delivery-v1) ────────────────────
        case "web-scrape-leads-v1": {
            const downloadUrl = typeof data.download_url === "string" ? data.download_url : "";
            if (!downloadUrl) {
                return { success: false, details: "Missing download_url for web-scrape-leads-v1" };
            }
            const requiredColumns = Array.isArray(data.spec?.required_columns)
                ? data.spec.required_columns
                : [];
            const minRows = typeof data.spec?.min_rows === "number"
                ? data.spec.min_rows
                : 0;
            try {
                const response = await fetch(downloadUrl, {
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) {
                    return { success: false, details: `Failed to fetch deliverable: HTTP ${response.status}` };
                }
                const text = await response.text();
                const lines = text.trim().split("\n");
                if (lines.length < 2) {
                    return { success: false, details: `CSV has ${lines.length} lines (need header + ≥1 data row)` };
                }
                const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
                const missingColumns = requiredColumns.filter(col => !headers.includes(col));
                if (missingColumns.length > 0) {
                    return { success: false, details: `Missing required columns: ${missingColumns.join(", ")}. Found: ${headers.join(", ")}` };
                }
                const dataRows = lines.length - 1;
                if (minRows > 0 && dataRows < minRows) {
                    return { success: false, details: `Row count ${dataRows} below minimum ${minRows}` };
                }
                return {
                    success: true,
                    details: `CSV valid: ${dataRows} rows, columns [${headers.join(", ")}]`,
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                return { success: false, details: `web-scrape-leads-v1 failed: ${message}` };
            }
        }
        case "transcribe-audio-v1": {
            const downloadUrl = typeof data.download_url === "string" ? data.download_url : "";
            if (!downloadUrl) {
                return { success: false, details: "Missing download_url for transcribe-audio-v1" };
            }
            const spec = data.spec ?? {};
            const expectedFormat = typeof spec.format === "string" ? spec.format.toLowerCase() : "";
            const minLengthChars = typeof spec.min_length_chars === "number" ? spec.min_length_chars : 0;
            const mustContainKeywords = Array.isArray(spec.must_contain_keywords) ? spec.must_contain_keywords : [];
            try {
                const response = await fetch(downloadUrl, {
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) {
                    return { success: false, details: `Failed to fetch deliverable: HTTP ${response.status}` };
                }
                const text = await response.text();
                if (text.trim().length === 0) {
                    return { success: false, details: "Transcription content is empty" };
                }
                if (expectedFormat) {
                    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
                    const urlLower = downloadUrl.toLowerCase();
                    const formatMatches = contentType.includes(expectedFormat) ||
                        urlLower.endsWith(`.${expectedFormat}`) ||
                        (expectedFormat === "txt" && (contentType.includes("text/plain") || urlLower.endsWith(".txt"))) ||
                        (expectedFormat === "srt" && (urlLower.endsWith(".srt"))) ||
                        (expectedFormat === "vtt" && (urlLower.endsWith(".vtt")));
                    if (!formatMatches) {
                        return { success: false, details: `Format mismatch: expected ${expectedFormat}, content-type=${contentType}, url=${downloadUrl}` };
                    }
                }
                if (minLengthChars > 0 && text.length < minLengthChars) {
                    return { success: false, details: `Content length ${text.length} below minimum ${minLengthChars} chars` };
                }
                if (mustContainKeywords.length > 0) {
                    const lower = text.toLowerCase();
                    const missing = mustContainKeywords.filter(kw => !lower.includes(kw.toLowerCase()));
                    if (missing.length > 0) {
                        return { success: false, details: `Missing required keywords: ${missing.join(", ")}` };
                    }
                }
                return {
                    success: true,
                    details: `Transcription valid: ${text.length} chars, format=${expectedFormat || "any"}`,
                };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                return { success: false, details: `transcribe-audio-v1 failed: ${message}` };
            }
        }
        case "classify-rows-v1": {
            const downloadUrl = typeof data.download_url === "string" ? data.download_url : "";
            if (!downloadUrl) {
                return { success: false, details: "Missing download_url for classify-rows-v1" };
            }
            const spec = data.spec ?? {};
            const requiredColumns = Array.isArray(spec.required_columns) ? spec.required_columns : [];
            const minRows = typeof spec.min_rows === "number" ? spec.min_rows : 0;
            const expectedFormat = typeof spec.format === "string" ? spec.format.toLowerCase() : "csv";
            const minConfidenceAvg = typeof spec.min_confidence_avg === "number" ? spec.min_confidence_avg : null;
            try {
                const response = await fetch(downloadUrl, {
                    signal: AbortSignal.timeout(15_000),
                });
                if (!response.ok) {
                    return { success: false, details: `Failed to fetch deliverable: HTTP ${response.status}` };
                }
                const text = await response.text();
                if (expectedFormat === "json") {
                    let parsed;
                    try {
                        parsed = JSON.parse(text);
                    }
                    catch {
                        return { success: false, details: "Content is not valid JSON" };
                    }
                    const rows = Array.isArray(parsed) ? parsed : [];
                    if (rows.length === 0) {
                        return { success: false, details: "JSON array is empty" };
                    }
                    const firstRow = rows[0];
                    const headers = Object.keys(firstRow);
                    const missingColumns = requiredColumns.filter(col => !headers.includes(col));
                    if (missingColumns.length > 0) {
                        return { success: false, details: `Missing required columns: ${missingColumns.join(", ")}. Found: ${headers.join(", ")}` };
                    }
                    if (minRows > 0 && rows.length < minRows) {
                        return { success: false, details: `Row count ${rows.length} below minimum ${minRows}` };
                    }
                    if (minConfidenceAvg !== null && headers.includes("confidence")) {
                        const confValues = rows
                            .map(r => Number(r["confidence"]))
                            .filter(n => Number.isFinite(n));
                        if (confValues.length > 0) {
                            const avg = confValues.reduce((a, b) => a + b, 0) / confValues.length;
                            if (avg < minConfidenceAvg) {
                                return { success: false, details: `Average confidence ${avg.toFixed(3)} below threshold ${minConfidenceAvg}` };
                            }
                        }
                    }
                    return { success: true, details: `JSON valid: ${rows.length} rows, columns [${headers.join(", ")}]` };
                }
                // CSV format
                const lines = text.trim().split("\n");
                if (lines.length < 2) {
                    return { success: false, details: `CSV has ${lines.length} lines (need header + ≥1 data row)` };
                }
                const headers = lines[0].split(",").map(h => h.trim().replace(/^"|"$/g, ""));
                const missingColumns = requiredColumns.filter(col => !headers.includes(col));
                if (missingColumns.length > 0) {
                    return { success: false, details: `Missing required columns: ${missingColumns.join(", ")}. Found: ${headers.join(", ")}` };
                }
                const dataRows = lines.length - 1;
                if (minRows > 0 && dataRows < minRows) {
                    return { success: false, details: `Row count ${dataRows} below minimum ${minRows}` };
                }
                if (minConfidenceAvg !== null && headers.includes("confidence")) {
                    const confIdx = headers.indexOf("confidence");
                    const confValues = lines.slice(1)
                        .map(line => {
                        const cols = line.split(",");
                        return Number(cols[confIdx]?.trim());
                    })
                        .filter(n => Number.isFinite(n));
                    if (confValues.length > 0) {
                        const avg = confValues.reduce((a, b) => a + b, 0) / confValues.length;
                        if (avg < minConfidenceAvg) {
                            return { success: false, details: `Average confidence ${avg.toFixed(3)} below threshold ${minConfidenceAvg}` };
                        }
                    }
                }
                return { success: true, details: `CSV valid: ${dataRows} rows, columns [${headers.join(", ")}]` };
            }
            catch (error) {
                const message = error instanceof Error ? error.message : "Unknown error";
                return { success: false, details: `classify-rows-v1 failed: ${message}` };
            }
        }
        default:
            return { success: true, details: "No auto-verification available for this type" };
    }
}
