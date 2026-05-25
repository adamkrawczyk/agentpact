export type AuditOrder = {
  id: string;
  stripe_session_id: string;
  buyer_email: string;
  contract_address: string;
  contract_chain: string;
  notes?: string | null;
  amount_cents: number;
  currency: string;
  status: string;
  created_at: string;
};

export type ReportBody = {
  report_md: string;
  severity_counts: { high: number; medium: number; low: number; info: number };
  verdict: "PASS" | "CONDITIONAL" | "FAIL";
  deliverable_url?: string;
  failure_reason?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class OrderAlreadyClaimed extends Error {
  constructor(orderId: string) {
    super(`Order ${orderId} already claimed (409)`);
    this.name = "OrderAlreadyClaimed";
  }
}

async function checkResponse(response: Response, context: string): Promise<Response> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ApiError(`${context} failed with ${response.status}: ${body}`, response.status);
  }
  return response;
}

export function createApiClient(input: {
  apiUrl: string;
  adminApiKey: string;
  fetchFn?: typeof fetch;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const baseUrl = input.apiUrl.replace(/\/$/, "");
  const headers = {
    "content-type": "application/json",
    "x-admin-api-key": input.adminApiKey,
  };

  async function listPaidOrders(limit = 10): Promise<AuditOrder[]> {
    const url = `${baseUrl}/api/audit/orders?status=paid&limit=${limit}`;
    const response = await checkResponse(
      await fetchFn(url, { headers }),
      "GET /api/audit/orders"
    );
    const data = (await response.json()) as { orders: AuditOrder[] };
    return data.orders;
  }

  async function claimOrder(id: string): Promise<AuditOrder> {
    const response = await fetchFn(`${baseUrl}/api/audit/orders/${id}/claim`, {
      method: "PATCH",
      headers,
    });
    if (response.status === 409) {
      throw new OrderAlreadyClaimed(id);
    }
    await checkResponse(response, `PATCH /api/audit/orders/${id}/claim`);
    return (await response.json()) as AuditOrder;
  }

  async function reportOrder(id: string, body: ReportBody): Promise<unknown> {
    const response = await checkResponse(
      await fetchFn(`${baseUrl}/api/audit/orders/${id}/report`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }),
      `POST /api/audit/orders/${id}/report`
    );
    return response.json();
  }

  async function refundOrder(id: string, reason: string): Promise<unknown> {
    const response = await checkResponse(
      await fetchFn(`${baseUrl}/api/audit/orders/${id}/refund`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reason }),
      }),
      `POST /api/audit/orders/${id}/refund`
    );
    return response.json();
  }

  return { listPaidOrders, claimOrder, reportOrder, refundOrder };
}

export type ApiClient = ReturnType<typeof createApiClient>;
