export class ApiError extends Error {
    status;
    constructor(message, status) {
        super(message);
        this.status = status;
        this.name = "ApiError";
    }
}
export class OrderAlreadyClaimed extends Error {
    constructor(orderId) {
        super(`Order ${orderId} already claimed (409)`);
        this.name = "OrderAlreadyClaimed";
    }
}
async function checkResponse(response, context) {
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new ApiError(`${context} failed with ${response.status}: ${body}`, response.status);
    }
    return response;
}
export function createApiClient(input) {
    const fetchFn = input.fetchFn ?? fetch;
    const baseUrl = input.apiUrl.replace(/\/$/, "");
    const headers = {
        "content-type": "application/json",
        "x-admin-api-key": input.adminApiKey,
    };
    async function listPaidOrders(limit = 10) {
        const url = `${baseUrl}/api/audit/orders?status=paid&limit=${limit}`;
        const response = await checkResponse(await fetchFn(url, { headers }), "GET /api/audit/orders");
        const data = (await response.json());
        return data.orders;
    }
    async function claimOrder(id) {
        const response = await fetchFn(`${baseUrl}/api/audit/orders/${id}/claim`, {
            method: "PATCH",
            headers,
        });
        if (response.status === 409) {
            throw new OrderAlreadyClaimed(id);
        }
        await checkResponse(response, `PATCH /api/audit/orders/${id}/claim`);
        return (await response.json());
    }
    async function reportOrder(id, body) {
        const response = await checkResponse(await fetchFn(`${baseUrl}/api/audit/orders/${id}/report`, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
        }), `POST /api/audit/orders/${id}/report`);
        return response.json();
    }
    async function refundOrder(id, reason) {
        const response = await checkResponse(await fetchFn(`${baseUrl}/api/audit/orders/${id}/refund`, {
            method: "POST",
            headers,
            body: JSON.stringify({ reason }),
        }), `POST /api/audit/orders/${id}/refund`);
        return response.json();
    }
    return { listPaidOrders, claimOrder, reportOrder, refundOrder };
}
