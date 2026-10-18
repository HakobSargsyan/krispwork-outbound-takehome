/**
 * Lead data access and the ICP filter. No MCP or transport concerns here --
 * just "what's a lead" and "does this lead match our ICP".
 *
 * leads.csv columns: lead_id, first_name, last_name, title, company, industry,
 * headcount, country, email. Several rows are missing title, first_name/
 * last_name, or headcount, so loading has to tolerate blanks instead of
 * assuming every field is populated.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parse } from "csv-parse/sync";

const LEADS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "leads.csv");

export interface Lead {
  id: string;
  name: string;
  title: string;
  company: string;
  industry: string;
  companySize: number | null;
  country: string;
  email: string;
  emailValid: boolean;
}

// Default ICP: economic-buyer-ish titles, at a company small enough to
// move fast but big enough to have a real budget (11-500 employees).
export const DEFAULT_SENIORITY_KEYWORDS = [
  "ceo",
  "coo",
  "founder",
  "chief",
  "vp",
  "vice president",
  "head of",
  "director",
];
export const DEFAULT_MIN_COMPANY_SIZE = 11;
export const DEFAULT_MAX_COMPANY_SIZE = 500;

interface LeadRow {
  lead_id: string;
  first_name: string;
  last_name: string;
  title: string;
  company: string;
  industry: string;
  headcount: string;
  country: string;
  email: string;
}

function parseHeadcount(raw: string): number | null {
  // headcount is blank (or occasionally non-numeric) for some rows in
  // leads.csv; treat those as unknown instead of crashing the whole load.
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// Deliberately loose -- just enough to catch what's actually wrong with
// leads.csv (e.g. a missing TLD like "grace.taylor@orbitfintech"), not a
// full RFC 5322 parser.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function loadLeads(): Lead[] {
  const csvText = readFileSync(LEADS_FILE, "utf-8");
  const rows: LeadRow[] = parse(csvText, { columns: true, skip_empty_lines: true });

  return rows.map((row) => {
    const email = row.email.trim().toLowerCase();
    return {
      id: row.lead_id.trim(),
      name: `${row.first_name.trim()} ${row.last_name.trim()}`.trim(),
      title: row.title.trim(),
      company: row.company.trim(),
      industry: row.industry.trim(),
      companySize: parseHeadcount(row.headcount),
      country: row.country.trim(),
      email,
      emailValid: EMAIL_PATTERN.test(email),
    };
  });
}

export function getLead(leadId: string): Lead | undefined {
  return loadLeads().find((lead) => lead.id === leadId);
}

export interface IcpFilter {
  minCompanySize?: number;
  maxCompanySize?: number;
  seniorityKeywords?: string[];
  industries?: string[];
  countryContains?: string;
  // Caps the result count at the first N matches in leads.csv's own row
  // order -- deliberately *not* a "top N by importance" ranking. Which
  // leads matter most (seniority? size? something else) is a
  // campaign-specific judgment call, not a fixed scoring formula this
  // function should bake in; the caller decides that and can request
  // narrower filters (or just reason over the full result set) instead.
  limit?: number;
}

export function matchesIcp(lead: Lead, filter: Required<Pick<IcpFilter, "minCompanySize" | "maxCompanySize" | "seniorityKeywords">> & IcpFilter): boolean {
  const title = lead.title.toLowerCase();
  if (filter.seniorityKeywords.length > 0 && !filter.seniorityKeywords.some((kw) => title.includes(kw.toLowerCase()))) {
    return false;
  }

  // A blank/unparseable headcount can't be confirmed to fit the size
  // window, so it's excluded rather than assumed to match.
  const size = lead.companySize;
  if (size === null || size < filter.minCompanySize || size > filter.maxCompanySize) {
    return false;
  }

  // Same reasoning as the headcount check: a lead with no usable email
  // can't actually be contacted, so don't surface it as a match.
  if (!lead.emailValid) {
    return false;
  }

  if (filter.industries && filter.industries.length > 0) {
    const industry = lead.industry.toLowerCase();
    if (!filter.industries.some((ind) => ind.toLowerCase() === industry)) {
      return false;
    }
  }

  if (filter.countryContains && !lead.country.toLowerCase().includes(filter.countryContains.toLowerCase())) {
    return false;
  }

  return true;
}

export function findMatchingLeads(filter: IcpFilter = {}): Lead[] {
  const resolved = {
    minCompanySize: filter.minCompanySize ?? DEFAULT_MIN_COMPANY_SIZE,
    maxCompanySize: filter.maxCompanySize ?? DEFAULT_MAX_COMPANY_SIZE,
    seniorityKeywords: filter.seniorityKeywords ?? DEFAULT_SENIORITY_KEYWORDS,
    industries: filter.industries,
    countryContains: filter.countryContains,
  };
  const matches = loadLeads().filter((lead) => matchesIcp(lead, resolved));
  return filter.limit !== undefined ? matches.slice(0, filter.limit) : matches;
}
