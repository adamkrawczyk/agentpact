# Autoresearch: MCP Tools

## Changelog

*Started: 2026-03-19 22:11 CET*
*Target: 80-90% from 21.6% baseline*
*Method: Karpathy autoresearch — mutate one thing, keep if better*

## Experiment 1 — keep

**Score:** 42/54 (77.8%)
**Change:** Clarified the sequence of operations for using the tools, emphasizing that registration and profile creation are prerequisites to using other tools such as creating offers or proposing deals. This addresses the top failing evals related to "Register and list a service" and "Find and hire a code review service."
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 2 — discard

**Score:** 39/54 (72.2%)
**Change:** Updated the "agentpact_create_offer" description to specify that an API key is required as an argument, obtained from the "agentpact_register" operation, which addresses the failing eval related to "Register and list a service: Created offer."
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 3 — discard

**Score:** 41/54 (75.9%)
**Change:** Updated the "agentpact_create_offer" description to clarify that an API key (obtained from "agentpact_register") is required as an argument and provided an example of a typical API key format. This addresses the failing eval related to "Register and list a service: Created offer."
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 4 — discard

**Score:** 41/54 (75.9%)
**Change:** Updated the "agentpact_create_offer" description to explicitly state that a valid API key is a required argument for the operation and provided an example of an API key format. This addresses the failing eval related to "Register and list a service: Created offer."
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 5 — discard

**Score:** 39/54 (72.2%)
**Change:** Updated the "agentpact_create_offer" description to specify that a valid API key and a completed agent profile are required arguments for creating an offer, with an example of a typical API key format. This aims to address the failing evals related to "Register and list a service: Created offer" by clarifying the necessary prerequisites.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 6 — discard

**Score:** 41/54 (75.9%)
**Change:** Updated the "agentpact_create_offer" description to explicitly state that an API key and a completed agent profile are required, and provided an example of a valid API key format. This change aims to address the failing evals related to "Register and list a service: Created offer" by clarifying the necessary prerequisites and providing a concrete example.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 7 — discard

**Score:** 41/54 (75.9%)
**Change:** Updated the "agentpact_create_offer" description to explicitly state that an API key (obtained from "agentpact_register") is a required argument and provided an example of a typical API key format. This aims to clarify the necessary prerequisites for creating an offer, addressing the failing evals related to "Register and list a service: Created offer."
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 8 — discard

**Score:** 33/54 (61.1%)
**Change:** Updated the "agentpact_create_offer" description to specify that an API key obtained from "agentpact_register" and a completed profile from "agentpact_create_agent" are necessary prerequisites, and provided an example format for an API key. This addresses the failing evals related to "Register and list a service: Created offer" by clarifying the necessary prerequisites and providing a concrete example.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 9 — discard

**Score:** 42/54 (77.8%)
**Change:** Updated the "agentpact_create_offer" description to specify the required sequence of operations and necessary prerequisites, including that a valid API key (obtained from "agentpact_register") and a completed profile (from "agentpact_create_agent") are required. This aims to address the failing evals related to "Register and list a service" by clarifying the necessary steps and prerequisites.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 10 — discard

**Score:** 40/54 (74.1%)
**Change:** Updated the "agentpact_create_offer" description to explicitly specify that an API key and a completed agent profile are required arguments, and to provide an example of how to structure the API key and handle prerequisites. This aims to address confusion in the "Register and list a service: Created offer" eval by clarifying the prerequisites and providing a concrete example.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 11 — discard

**Score:** 38/54 (70.4%)
**Change:** Simplified the description of the "agentpact_propose_deal" tool to focus on the essential requirements for usage, clarifying the necessary arguments and providing a format example for the price argument.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 12 — discard

**Score:** 41/54 (75.9%)
**Change:** Added a warning about common mistakes in the "agentpact_propose_deal" description, specifying the correct format for the required arguments and emphasizing the need to use valid offer and buyer agent IDs obtained from prior steps.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 13 — discard

**Score:** 42/54 (77.8%)
**Change:** Added a warning about common mistakes in the "agentpact_create_offer" tool description, specifying the importance of using a valid agent ID and ensuring that the profile is complete. This aims to prevent errors related to incomplete profiles when agents attempt to create offers.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 14 — discard

**Score:** 38/54 (70.4%)
**Change:** Added a WORKFLOW SUMMARY at the top to clarify the sequence of operations required for using the tools effectively.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 15 — discard

**Score:** 40/54 (74.1%)
**Change:** Updated the "agentpact_propose_deal" tool description to clearly specify the required arguments (buyerAgentId, offerId, price) and their formats, including an example for the price argument. This aims to improve understanding of how to properly use this tool for deal creation.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 16 — discard

**Score:** 35/54 (64.8%)
**Change:** Added a WORKFLOW SUMMARY at the top of all tool descriptions to clarify the sequence of operations required for using the tools effectively.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 17 — discard

**Score:** 41/54 (75.9%)
**Change:** Added a WORKFLOW SUMMARY at the top of each tool description to clarify the sequence of operations: 'Step 1: register → Step 2: create_agent → Step 3: create_offer/search_offers'. This aims to provide clear guidance on the initial steps needed before using other tools.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 18 — discard

**Score:** 34/54 (63.0%)
**Change:** Simplified the description of the "agentpact_register" tool to focus on the essential process of obtaining the API key, specifying that the agent ID must be a UUID, and clarifying that wallet_address is optional and can be added later.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 19 — discard

**Score:** 40/54 (74.1%)
**Change:** Updated the "agentpact_create_offer" tool description to specify the required arguments with their types and format, including examples for each argument where applicable. This aims to minimize errors when creating an offer by making the argument requirements explicit and clear.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 20 — discard

**Score:** 34/54 (63.0%)
**Change:** Completely restructured the descriptions to emphasize the workflow sequence and provide clear guidance on required arguments and formats. Added examples where applicable to enhance understanding, especially for complex tools.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 21 — discard

**Score:** 37/54 (68.5%)
**Change:** Added a WORKFLOW SUMMARY at the top of the tool descriptions to clarify the sequence of operations: 'Step 1: Register → Step 2: Create Agent Profile → Step 3: Create Offer/Search Offers'. This aims to help AI agents understand the initial steps required before using other tools.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 22 — discard

**Score:** 35/54 (64.8%)
**Change:** Reorganized the tool descriptions with a new approach focusing on a structured, step-by-step process for using the tools. Each section highlights the purpose, prerequisites, and necessary inputs with example values where applicable.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 23 — discard

**Score:** 41/54 (75.9%)
**Change:** Added a warning about the common mistake of not using a string format for the price argument in the `agentpact_propose_deal` tool description to prevent errors related to incorrect data types.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 24 — discard

**Score:** 37/54 (68.5%)
**Change:** Reimagined and reformatted the tool descriptions to clarify the sequence and context of operations and provide detailed guidance on required arguments, their types, and possible values, using a clear and consistent format throughout.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 25 — discard

**Score:** 35/54 (64.8%)
**Change:** Simplified the description for the `agentpact_register` tool by focusing solely on the essential process of registration and obtaining the API key, while retaining the necessary information about the agent ID and optional wallet address.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 26 — discard

**Score:** 40/54 (74.1%)
**Change:** Clarified the sequential order of operations that must be followed, emphasizing that registration and creating an agent profile are mandatory prerequisites for many other tools. This should help AI agents understand the necessary steps before using other functionalities.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 27 — discard

**Score:** 38/54 (70.4%)
**Change:** Added a "WORKFLOW SUMMARY" at the top of the descriptions to clearly outline the initial steps required before using other tools: 'Step 1: register → Step 2: create_agent → Step 3: create_offer/search_offers'. This aims to guide AI agents through the necessary initial steps.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 28 — discard

**Score:** 40/54 (74.1%)
**Change:** Added a warning about the common mistake of omitting required arguments or misformatting them in the `agentpact_create_offer` tool description, along with examples of correct argument formats. This aims to prevent frequent errors.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 29 — discard

**Score:** 41/54 (75.9%)
**Change:** Updated the description for the `agentpact_create_offer` tool to include explicit argument names, types, and example values. This aims to reduce errors by ensuring AI agents understand how to correctly format each input.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 30 — discard

**Score:** 36/54 (66.7%)
**Change:** Reformatted the tool descriptions to include a "REQUIRED INPUTS" section that clearly specifies the arguments needed, their types, and examples. This approach aims to help AI agents understand exactly what input is required for each tool. For this iteration, applied this change to only the `agentpact_register` and `agentpact_create_agent` tools as a test case.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 31 — discard

**Score:** 40/54 (74.1%)
**Change:** Added a "WORKFLOW SUMMARY" at the top of the descriptions to clearly outline the initial steps required before using other tools: 'Step 1: register → Step 2: create_agent → Step 3: create_offer/search_offers'. This aims to guide AI agents through the necessary initial steps.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 32 — discard

**Score:** 40/54 (74.1%)
**Change:** Updated the description for the `agentpact_propose_deal` tool to include explicit argument names, types, and example values. This aims to reduce errors by ensuring AI agents understand how to correctly format each input.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 33 — discard

**Score:** 42/54 (77.8%)
**Change:** Added a warning about common mistakes in the `agentpact_create_offer` tool description, specifically the requirement for properly formatted arguments and their sequence, with a reminder that the agent's profile must be completed first.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 34 — discard

**Score:** 40/54 (74.1%)
**Change:** Updated the description for the `agentpact_propose_deal` tool to clearly specify the required arguments (buyerAgentId, offerId, price), their formats, and provide example values. This aims to improve understanding of how to correctly use this tool for deal creation.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 35 — discard

**Score:** 39/54 (72.2%)
**Change:** Added a brief example JSON illustrating the correct argument formats for the `agentpact_create_offer` tool, as this tool had multiple evaluations indicating errors in its usage.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 36 — discard

**Score:** 42/54 (77.8%)
**Change:** Added an example JSON to the `agentpact_create_offer` tool description, illustrating the correct argument formats to reduce errors related to offer creation.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 37 — discard

**Score:** 34/54 (63.0%)
**Change:** Added a "WORKFLOW SUMMARY" at the top of the descriptions to clearly outline the initial steps required before using other tools: 'Step 1: register → Step 2: create_agent → Step 3: create_offer/search_offers'. This aims to guide AI agents through the necessary initial steps.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Under 8 tool calls

## Experiment 38 — discard

**Score:** 41/54 (75.9%)
**Change:** Updated the `agentpact_propose_deal` description to explicitly list the required arguments (buyerAgentId, offerId, price), their formats, and provide clear examples of these values. This aims to ensure agents understand the correct inputs needed to propose a deal.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 39 — discard

**Score:** 42/54 (77.8%)
**Change:** Added a clear sequence guideline at the beginning of the tool descriptions to outline the required initial steps before using other tools. This helps ensure AI agents understand the correct order for registration, profile creation, and subsequent actions.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal

## Experiment 40 — discard

**Score:** 41/54 (75.9%)
**Change:** Adjusted the description of the `agentpact_propose_deal` tool to clarify that `buyerAgentId`, `offerId`, and `price` are mandatory arguments. Included example values for each argument to enhance understanding.
**Top failures:** Find and hire a code review service: Proposed a deal; Find and hire a code review service: No errors in critical path; Find and hire a code review service: Proposed a deal
