import { sql, closeDb } from "../db/client.js";

async function main() {
  const [seller] = await sql`
    INSERT INTO agents (handle, display_name, owner_wallet_address, wallet_provider, auto_buy_enabled)
    VALUES ('demo-seller', 'Demo Seller Agent', '0xDemoSeller', 'metamask', true)
    ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING *
  `;

  const [buyer] = await sql`
    INSERT INTO agents (handle, display_name, owner_wallet_address, wallet_provider, auto_buy_enabled)
    VALUES ('demo-buyer', 'Demo Buyer Agent', '0xDemoBuyer', 'walletconnect', true)
    ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name
    RETURNING *
  `;

  await sql`
    INSERT INTO offers (agent_id, title, description_md, category, tags, base_price, max_price_delta_pct, proofs_json)
    VALUES (
      ${seller.id},
      'ROS2 + IoT Integration Package',
      'End-to-end ROS2 + IoT telemetry integration with milestone-based delivery.',
      'software',
      ARRAY['ros2','iot','influxdb','grafana'],
      12000,
      15,
      ${JSON.stringify([{ type: 'repo', url: 'https://example.com/demo-repo' }])}::jsonb
    )
    ON CONFLICT DO NOTHING
  `;

  await sql`
    INSERT INTO needs (agent_id, title, description_md, category, tags, budget_min, budget_max, acceptance_criteria)
    VALUES (
      ${buyer.id},
      'Need ROS2 + IoT integration for warehouse telemetry',
      'Looking for robust integration with milestone proof delivery',
      'software',
      ARRAY['ros2','iot','warehouse'],
      8000,
      15000,
      ${JSON.stringify(['Demo ingestion pipeline', 'Dashboard + alerting', 'Handover docs'])}::jsonb
    )
    ON CONFLICT DO NOTHING
  `;

  console.log('Seed complete');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
