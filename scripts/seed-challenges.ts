import { sql, closeDb } from "../db/client.js";

async function main() {
  const categories = ["code-review", "ai-services", "data-analysis"];

  await sql`
    DELETE FROM skill_challenges
    WHERE category = ANY(${categories}::text[])
  `;

  await sql`
    INSERT INTO skill_challenges (
      category,
      title,
      description_md,
      difficulty,
      input_payload,
      expected_criteria,
      time_limit_minutes,
      active
    ) VALUES
      (
        'code-review',
        'Python Bug Hunt',
        'Review the provided Python function and identify at least 3 bugs or reliability issues.',
        'basic',
        ${JSON.stringify({
          language: "python",
          task: "Find and explain bugs in the function",
          code: "def calc_totals(items=[]):\n    total = 0\n    for i in range(len(items)+1):\n        total += items[i]\n    return total / len(items)",
          requiredOutput: "Return JSON: { bugs: [{ issue, impact, fix }] }",
        })}::jsonb,
        ${JSON.stringify({
          mode: "keyword",
          keywords: ["mutable default", "off-by-one", "division by zero"],
          minMatches: 3,
        })}::jsonb,
        30,
        TRUE
      ),
      (
        'ai-services',
        'Structured AI Service Output',
        'Given a prompt, return a structured JSON response that matches the required schema.',
        'standard',
        ${JSON.stringify({
          prompt: "Summarize this support ticket and propose next actions",
          ticketText: "Customer cannot access billing portal and reports 2FA loop.",
          outputSchema: {
            summary: "string",
            severity: "low|medium|high",
            actions: ["string"],
          },
        })}::jsonb,
        ${JSON.stringify({
          mode: "required_json_keys",
          requiredKeys: ["summary", "severity", "actions"],
        })}::jsonb,
        30,
        TRUE
      ),
      (
        'data-analysis',
        'CSV Summary Analysis',
        'Analyze the provided CSV and return summary statistics with interpretation.',
        'standard',
        ${JSON.stringify({
          datasetName: "weekly_sales.csv",
          csv: "week,orders,revenue\n1,12,1100\n2,18,1840\n3,15,1495\n4,21,2300",
          requiredOutput: "Return JSON summary with totals and descriptive stats",
        })}::jsonb,
        ${JSON.stringify({
          mode: "keyword",
          keywords: ["mean", "median", "min", "max"],
          minMatches: 4,
        })}::jsonb,
        30,
        TRUE
      )
  `;

  console.log("Seeded 3 skill challenges");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
