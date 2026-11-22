'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Amount, DateDisplay, LoadMore } from '@/components/shared'
import { responseError, useCursorList } from '@/hooks/use-cursor-list'

interface ReceiptTransaction {
  id: string
  counterpartyName: string | null
  label: string | null
  date: string
  amount: number
  reconciledWith?: string | null
  transactionUuid?: string | null
  attachments: Array<{ id: string; fileName: string }>
}

export function PurchaseReceiptArchive({ companyId }: { companyId: string }) {
  const [open, setOpen] = useState(false)

  return (
    <Card>
      <CardHeader>
        <CardTitle>Justificatifs d’achat archivés</CardTitle>
        <CardDescription>Les pièces rattachées aux débits bancaires de la société.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <Button
          variant="outline"
          aria-expanded={open}
          aria-controls="purchase-receipt-archive"
          onClick={() => setOpen(!open)}
        >
          {open ? 'Masquer les justificatifs' : 'Rechercher un justificatif'}
        </Button>
        <div id="purchase-receipt-archive" hidden={!open}>
          {open ? <ArchiveList companyId={companyId} /> : null}
        </div>
      </CardContent>
    </Card>
  )
}

function ArchiveList({ companyId }: { companyId: string }) {
  const [search, setSearch] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), 300)
    return () => clearTimeout(timer)
  }, [search])

  const query = new URLSearchParams({
    companyId, side: 'debit', hasAttachments: 'with', limit: '25',
    ...(debounced ? { searchText: debounced } : {}),
  }).toString()
  const list = useCursorList<ReceiptTransaction>(query, async (cursor, signal) => {
    const response = await fetch(`/api/transactions?${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, { signal })
    if (!response.ok) throw new Error(await responseError(response, 'Impossible de charger les justificatifs.'))
    const page = await response.json() as { transactions: ReceiptTransaction[]; nextCursor?: string }
    return { items: page.transactions, nextCursor: page.nextCursor ?? null }
  })

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="purchase-receipt-search">Fournisseur ou numéro de facture</Label>
        <Input id="purchase-receipt-search" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {list.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          {list.error}
          <Button size="sm" variant="outline" onClick={list.reload}>Réessayer</Button>
        </div>
      ) : null}
      {list.loading ? <p role="status">Chargement des justificatifs…</p> : null}
      {!list.loading && !list.error && list.items.length === 0 ? <p>Aucun justificatif trouvé.</p> : null}
      {list.items.length > 0 ? (
        <ul className="divide-y rounded-md border">
          {list.items.map((transaction) => (
            <li key={transaction.id} className="space-y-1 p-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="font-medium">{transaction.counterpartyName || transaction.label || 'Débit bancaire'}</span>
                <DateDisplay value={transaction.date} />
                <Amount value={Math.abs(transaction.amount)} />
                {transaction.reconciledWith ? (
                  <Link className="text-link" href={`/${companyId}/entries/${transaction.reconciledWith}`}>Voir l’écriture</Link>
                ) : null}
              </div>
              <ul className="space-y-1 text-sm">
                {transaction.attachments.map((file) => {
                  const params = new URLSearchParams({ companyId })
                  if (transaction.transactionUuid) params.set('transactionUuid', transaction.transactionUuid)
                  return (
                    <li key={file.id}>
                      <a className="text-link break-words" target="_blank" rel="noopener noreferrer"
                        href={`/api/banking/attachments/${encodeURIComponent(file.id)}/proxy?${params}`}>
                        {file.fileName}
                      </a>
                    </li>
                  )
                })}
              </ul>
            </li>
          ))}
        </ul>
      ) : null}
      <LoadMore hasMore={list.hasMore} loading={list.loadingMore} error={list.loadMoreError} onLoadMore={list.loadMore} />
    </div>
  )
}
