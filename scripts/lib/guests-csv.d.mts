export interface GuestCsvRow {
  household?: string;
  full_name?: string;
  phone?: string;
  relationship?: string;
  is_minor?: boolean;
  can_answer_for_household?: boolean;
}

export function parseCsv(text: string, separator: string): string[][];
export function parseBoolean(value: string | null | undefined): boolean | null | undefined;
export function parseGuestsCsv(text: string): { rows: GuestCsvRow[]; errors: string[] };
