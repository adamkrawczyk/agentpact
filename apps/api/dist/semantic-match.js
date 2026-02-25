const EMBEDDING_MODEL = "text-embedding-3-small";
const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
const MAX_BATCH_SIZE = 20;
const MAX_RETRIES = 4;
const BASE_BACKOFF_MS = 800;
const embeddingCache = new Map();
function normalizeText(text) {
    return text.trim();
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0)
        return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
async function fetchEmbeddingsBatch(inputs) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
        throw new Error("OPENAI_API_KEY is not set");
    }
    let attempt = 0;
    while (attempt < MAX_RETRIES) {
        attempt += 1;
        const response = await fetch(OPENAI_EMBEDDINGS_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: EMBEDDING_MODEL,
                input: inputs,
            }),
        });
        if (response.ok) {
            const payload = (await response.json());
            return payload.data
                .slice()
                .sort((left, right) => left.index - right.index)
                .map((item) => item.embedding);
        }
        if (response.status === 429 || response.status >= 500) {
            const retryAfter = Number(response.headers.get("retry-after") ?? 0);
            const backoffMs = retryAfter > 0
                ? retryAfter * 1000
                : BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
            await sleep(backoffMs);
            continue;
        }
        const errorText = await response.text();
        throw new Error(`Embedding request failed (${response.status}): ${errorText.slice(0, 300)}`);
    }
    throw new Error("Embedding request failed after retries");
}
export function isSemanticMatchingEnabled() {
    return Boolean(process.env.OPENAI_API_KEY);
}
export function cacheEmbedding(text, embedding) {
    const normalized = normalizeText(text);
    if (!normalized || embedding.length === 0)
        return;
    embeddingCache.set(normalized, embedding);
}
export async function generateEmbeddings(texts) {
    const normalizedTexts = texts.map((text) => normalizeText(text));
    const result = new Array(normalizedTexts.length);
    const missing = new Map();
    for (let i = 0; i < normalizedTexts.length; i += 1) {
        const text = normalizedTexts[i];
        const cached = embeddingCache.get(text);
        if (cached) {
            result[i] = cached;
            continue;
        }
        const indices = missing.get(text);
        if (indices) {
            indices.push(i);
        }
        else {
            missing.set(text, [i]);
        }
    }
    const pendingTexts = Array.from(missing.keys());
    for (let offset = 0; offset < pendingTexts.length; offset += MAX_BATCH_SIZE) {
        const batch = pendingTexts.slice(offset, offset + MAX_BATCH_SIZE);
        const batchEmbeddings = await fetchEmbeddingsBatch(batch);
        for (let i = 0; i < batch.length; i += 1) {
            const text = batch[i];
            const embedding = batchEmbeddings[i];
            embeddingCache.set(text, embedding);
            const indices = missing.get(text) ?? [];
            for (const idx of indices) {
                result[idx] = embedding;
            }
        }
    }
    return result;
}
export async function generateEmbedding(text) {
    const [embedding] = await generateEmbeddings([text]);
    return embedding;
}
export async function computeSemanticScore(offerText, needText) {
    const [offerEmbedding, needEmbedding] = await generateEmbeddings([offerText, needText]);
    return cosineSimilarity(offerEmbedding, needEmbedding);
}
