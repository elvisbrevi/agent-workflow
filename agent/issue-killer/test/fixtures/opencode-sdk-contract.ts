import type {
  ApiError,
  AssistantMessage,
  EventPermissionV2Asked,
  EventSessionError,
  ModelRef,
  OutputFormat,
  PermissionConfig,
  PermissionRuleset,
  PromptInput,
  SessionPromptData,
  StructuredOutputError,
} from "@opencode-ai/sdk/v2"

export const promptInput = {
  text: "Work only on the host-pinned issue.",
} satisfies PromptInput

export const model = {
  id: "model-id",
  providerID: "provider-id",
  variant: "high",
} satisfies ModelRef

export const structuredOutput = {
  type: "json_schema",
  schema: {
    type: "object",
    properties: {
      status: { type: "string" },
      issue: { type: "integer" },
      summary: { type: "string" },
    },
    required: ["status", "issue", "summary"],
  },
  retryCount: 2,
} satisfies OutputFormat

export const promptRequest = {
  path: {
    sessionID: "ses_contract_fixture",
  },
  query: {
    directory: "/tmp/issue-killer-sandbox",
  },
  body: {
    model: {
      providerID: "provider-id",
      modelID: "model-id",
    },
    variant: "high",
    format: structuredOutput,
    parts: [
      {
        type: "text",
        text: promptInput.text,
      },
    ],
  },
  url: "/session/{sessionID}/message",
} satisfies SessionPromptData

export const autonomousPermission = {
  read: "allow",
  edit: "allow",
  glob: "allow",
  grep: "allow",
  bash: "allow",
  task: "allow",
} satisfies PermissionConfig

export const sessionPermissionRules = [
  {
    permission: "read",
    pattern: "*",
    action: "allow",
  },
] satisfies PermissionRuleset

export const structuredAssistantFields = {
  structured: {
    status: "ISSUE_COMPLETED",
    issue: 123,
    summary: "validated",
  },
  variant: "high",
} satisfies Pick<AssistantMessage, "structured" | "variant">

export const structuredOutputError = {
  name: "StructuredOutputError",
  data: {
    message: "structured output failed",
    retries: 2,
  },
} satisfies StructuredOutputError

export const apiError = {
  name: "APIError",
  data: {
    message: "provider unavailable",
    statusCode: 503,
    isRetryable: true,
    responseHeaders: {
      "retry-after": "1",
    },
  },
} satisfies ApiError

export const sessionErrorEvent = {
  id: "evt_contract_error",
  type: "session.error",
  properties: {
    sessionID: "ses_contract_fixture",
    error: apiError,
  },
} satisfies EventSessionError

export const permissionAskedEvent = {
  id: "evt_contract_permission",
  type: "permission.v2.asked",
  properties: {
    id: "perm_contract_fixture",
    sessionID: "ses_contract_fixture",
    action: "edit",
    resources: ["src/example.ts"],
    source: {
      type: "tool",
      messageID: "msg_contract_fixture",
      callID: "call_contract_fixture",
    },
  },
} satisfies EventPermissionV2Asked
