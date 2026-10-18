/**
 * Email-drafting logic: pure text generation, no MCP or transport concerns.
 * Draft only -- nothing in this module sends mail.
 */

import type { Lead } from "./leads.js";

export const DEFAULT_SENDER_NAME = "Alex";
export const DEFAULT_SENDER_COMPANY = "Krisp";
export const DEFAULT_VALUE_PROP =
  "an AI-powered copilot that cuts noise and repetitive work out of customer conversations";

export interface EmailDraft {
  to: string;
  subject: string;
  body: string;
}

function openingLine(lead: Lead): string {
  // Title is blank on a few rows; drop the role clause rather than
  // printing "given your role as ."
  const roleClause = lead.title ? `, given your role as ${lead.title}` : "";
  // Company/industry are blank on a few rows too; fall back to phrasing
  // that doesn't name an empty string rather than printing "Saw that  has
  // been growing on the  side".
  if (lead.company && lead.industry) {
    return (
      `Saw that ${lead.company} has been growing on the ${lead.industry} side, ` +
      `and figured it was worth a quick note${roleClause}.`
    );
  }
  if (lead.company) {
    return `Saw that ${lead.company} has been growing, and figured it was worth a quick note${roleClause}.`;
  }
  if (lead.industry) {
    return `Saw that things have been moving on the ${lead.industry} side, and figured it was worth a quick note${roleClause}.`;
  }
  return `Figured it was worth a quick note${roleClause}.`;
}

export function draftFirstEmail(
  lead: Lead,
  senderName: string = DEFAULT_SENDER_NAME,
  senderCompany: string = DEFAULT_SENDER_COMPANY,
  valueProp: string = DEFAULT_VALUE_PROP,
): EmailDraft {
  // A couple of rows have no name at all; fall back to a plain greeting
  // rather than leaving "Hi ," in the draft.
  const firstName = lead.name ? lead.name.split(" ")[0] : null;
  const greeting = firstName ? `Hi ${firstName},` : "Hi,";

  const subject = lead.company ? `Quick question about ${lead.company}'s workflow` : "Quick question about your workflow";
  const closingAsk = lead.company ? `to see if it's a fit for ${lead.company}` : "to see if it's a fit for your team";
  const body =
    `${greeting}\n\n` +
    `${openingLine(lead)}\n\n` +
    `We built ${valueProp} — teams like yours typically use it to save a few hours a week without adding headcount.\n\n` +
    `Worth a quick 15-minute call ${closingAsk}?\n\n` +
    `Best,\n${senderName}\n${senderCompany}`;

  return { to: lead.email, subject, body };
}
