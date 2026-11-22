import { describe, expect, it } from 'vitest'
import { secretiarDocumentUrl } from '../secretiar-document'

describe('Secretiar sales archive', () => {
  const line = { account: { code: '411' }, auxiliaryAccountNumber: 'tenant-example' }
  const entry = { journal: { code: 'VE' }, entryNumber: 'SEC-FAC-2026-000001', reference: 'FAC-2026-000001', lines: [line] }
  it.each(['FAC', 'AVO'])('links the archived %s document', prefix => {
    const number = prefix + '-2026-000001'
    expect(secretiarDocumentUrl('a', { ...entry, reference: number, entryNumber: 'SEC-' + number }, 'a'))
      .toBe('https://secretiar.com/admin/billing-document?tenantId=tenant-example&number=' + number)
  })
  it('requires an opted-in company, source number, sales journal and unambiguous customer', () => {
    expect(secretiarDocumentUrl('a', entry, 'b')).toBeNull()
    for (const patch of [{ entryNumber: '3' }, { journal: { code: 'BQ' } }, { lines: [] }, { lines: [line, { ...line, auxiliaryAccountNumber: 'other' }] }]) {
      expect(secretiarDocumentUrl('a', { ...entry, ...patch }, 'a')).toBeNull()
    }
  })
})
