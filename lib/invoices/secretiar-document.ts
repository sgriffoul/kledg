/** Secretiar VE exports keep the document number and the tenant's 411 auxiliary. */
export function secretiarDocumentUrl(companyId: string, entry: {
  entryNumber: string; reference: string | null; journal: { code: string }
  lines: Array<{ account: { code: string }; auxiliaryAccountNumber: string | null }>
}, configuredCompany: string | undefined) {
  if (companyId !== configuredCompany || entry.journal.code !== 'VE') return null
  const number = entry.reference
  if (!number || !/^(FAC|AVO)-\d{4}-(?!0+$)\d{6,}$/.test(number) || entry.entryNumber !== `SEC-${number}`) return null
  const clients = entry.lines.filter(line => line.account.code.startsWith('411'))
  const tenants = new Set(clients.map(line => line.auxiliaryAccountNumber))
  const tenant = clients[0]?.auxiliaryAccountNumber
  if (tenants.size !== 1 || !tenant || !/^[\w-]{1,128}$/.test(tenant)) return null
  const query = new URLSearchParams({ tenantId: tenant, number })
  return `https://secretiar.com/admin/billing-document?${query}`
}
