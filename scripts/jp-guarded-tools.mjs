// Explicit names avoid ambiguous native tool dispatch. Virtual transport only so far.
export const guardedTools = () => [
  {
    type: "client_side_tool",
    client_side_tool: {
      name: "read_current_menu",
      description:
        "Read the latest completed menu and its one-use token before selecting an IVR option.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      },
    },
  },
  {
    type: "client_side_tool",
    client_side_tool: {
      name: "press_ivr_digit",
      description:
        "Send exactly one advertised digit for the authorized task, using the latest menu token. Never end the call.",
      parameters: {
        type: "object",
        properties: {
          digits: { type: "string", pattern: "^[0-9*#]$" },
          menu_token: { type: "string" },
        },
        required: ["digits", "menu_token"],
        additionalProperties: false,
      },
    },
  },
  {
    type: "client_side_tool",
    client_side_tool: {
      name: "finish_call_after_goodbye",
      description:
        "Request closure only for a settled outcome. The controller waits for the complete assistant farewell and recipient silence. Never use to select a menu.",
      parameters: {
        type: "object",
        properties: {
          outcome: {
            type: "string",
            enum: ["confirmed", "refused", "wrong_number", "unable_to_proceed"],
          },
        },
        required: ["outcome"],
        additionalProperties: false,
      },
    },
  },
];
export const guardedInstructions = `Only these tools exist: read_current_menu, press_ivr_digit, finish_call_after_goodbye. Native hangup/send_dtmf are not available. For a completed IVR menu, first read_current_menu, then select the explicitly advertised option for the authorized task and call press_ivr_digit with its exact digit and returned menu_token. Do not wait instead of selecting an offered option. Never pass digits to finish_call_after_goodbye. Never enter credentials, OTPs, account numbers or payment. If no safe option exists, return the reason for the frontend to explain, then request finish_call_after_goodbye with unable_to_proceed. This is a closure request, not immediate hangup: the controller waits for a complete assistant farewell, drained audio and recipient silence. Never claim actual remote tone delivery from a simulation result. After requesting closure, finish your single farewell if not already complete, then remain silent. New recipient speech cancels pending closure.`;
