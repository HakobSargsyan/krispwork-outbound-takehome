/**
 * Registers the two outbound-sales MCP tools onto a given McpServer. Each
 * tool is a thin wrapper around leads.ts / outreach.ts -- the actual ICP
 * and drafting logic lives there, not here.
 */

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  DEFAULT_MAX_COMPANY_SIZE,
  DEFAULT_MIN_COMPANY_SIZE,
  findMatchingLeads,
  getLead,
} from "./leads.js";
import { DEFAULT_SENDER_COMPANY, DEFAULT_SENDER_NAME, DEFAULT_VALUE_PROP, draftFirstEmail } from "./outreach.js";

export function registerTools(mcp: McpServer): void {
  mcp.registerTool(
    "find_leads",
    {
      title: "Find leads",
      description:
        "Filter leads.csv by a simple ICP. Default ICP: title indicates a decision-maker " +
        "(CEO/COO/Founder/VP/Head of/Director/Chief) at a company with 11-500 employees " +
        "(headcount). Leads with a blank/unparseable headcount or an invalid email are " +
        "excluded. Pass the optional args to narrow further (industries, a country " +
        "substring) or override the defaults (seniorityKeywords, size range). `limit` caps " +
        "the result count at the first N matches in leads.csv's own row order -- it does " +
        "NOT rank by seniority, company size, or any other notion of \"best\" lead; if you " +
        "need a specific top-N by some criterion, filter for it explicitly or reason over " +
        "the full result set yourself.",
      inputSchema: {
        minCompanySize: z.number().int().optional().default(DEFAULT_MIN_COMPANY_SIZE),
        maxCompanySize: z.number().int().optional().default(DEFAULT_MAX_COMPANY_SIZE),
        seniorityKeywords: z.array(z.string()).optional(),
        industries: z.array(z.string()).optional(),
        countryContains: z.string().optional(),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ minCompanySize, maxCompanySize, seniorityKeywords, industries, countryContains, limit }) => {
      const leads = findMatchingLeads({ minCompanySize, maxCompanySize, seniorityKeywords, industries, countryContains, limit });
      return { content: [{ type: "text", text: JSON.stringify(leads, null, 2) }] };
    },
  );

  mcp.registerTool(
    "draft_email",
    {
      title: "Draft email",
      description:
        "Draft a short first outbound email for one lead. Draft only -- this tool does " +
        "not send email; it returns the subject/body for a human (or another tool) to " +
        "review and send.",
      inputSchema: {
        leadId: z.string(),
        senderName: z.string().optional().default(DEFAULT_SENDER_NAME),
        senderCompany: z.string().optional().default(DEFAULT_SENDER_COMPANY),
        valueProp: z.string().optional().default(DEFAULT_VALUE_PROP),
      },
    },
    async ({ leadId, senderName, senderCompany, valueProp }) => {
      const lead = getLead(leadId);
      if (!lead) {
        return {
          isError: true,
          content: [{ type: "text", text: `No lead found with id=${JSON.stringify(leadId)}` }],
        };
      }
      if (!lead.emailValid) {
        return {
          isError: true,
          content: [{ type: "text", text: `Lead ${leadId} has no usable email address (got ${JSON.stringify(lead.email)})` }],
        };
      }
      const draft = draftFirstEmail(lead, senderName, senderCompany, valueProp);
      return { content: [{ type: "text", text: JSON.stringify(draft, null, 2) }] };
    },
  );
}
