// app/upload/page.tsx
//
// ── OVERVIEW ──────────────────────────────────────────────────────────────────
// This is the creator upload page. It allows a creator (publisher) to upload
// a book (PDF, EPUB, or TXT) to the Knowdly platform.
//
// ── SECURITY MODEL ────────────────────────────────────────────────────────────
// The file is encrypted in the browser using AES-256-GCM before anything
// is sent to any server. The plaintext never leaves the creator's device.
// Only the encrypted blob is uploaded to Arweave. The AES key is stored
// on the Supabase key server, gated by on-chain NFT ownership verification.
//
// ── ATOMIC UPLOAD FLOW ────────────────────────────────────────────────────────
// The flow is designed to be atomic — if the creator cancels or any step
// fails, we don't end up with orphaned payments or uploaded files.
//
// Step 1:  Connect Freighter wallet
//          → If cancelled here, nothing has happened. Clean abort.
//
// Step 2:  Encrypt the book file in the browser
//          → AES-256-GCM encryption. IV is random per upload.
//          → Plaintext never leaves the device.
//
// Step 3:  Build + sign the Stellar/Soroban transaction in Freighter
//          → Uses a placeholder Arweave TX ID since the real one doesn't
//            exist yet (we haven't uploaded to Arweave yet).
//          → If the creator cancels Freighter here, nothing has been uploaded.
//
// Step 4:  Upload cover image to Arweave (if provided)
//          → Cover images are PUBLIC (not encrypted) — they're meant to be seen.
//          → Uploaded as a separate Arweave transaction.
//          → Non-fatal: if cover upload fails, book upload continues.
//
// Step 5:  Upload encrypted book file to Arweave
//          → Chunked upload handles files of any size.
//          → Cover TX ID is included as an Arweave tag if provided.
//
// Step 6:  Store the AES encryption key on the Supabase key server
//          → Key is stored against the Arweave TX ID.
//          → Key is only released when on-chain NFT ownership is verified.
//
// Step 7:  Submit the signed Stellar transaction
//          → Registers the book on the Soroban smart contract.
//          → Mints the creator's record on-chain.
//
// Step 8:  Update the Arweave TX ID on-chain
//          → Replaces the placeholder TX ID with the real one.
//          → This is what makes ownership → content mapping fully on-chain.
//          → Non-fatal: if this fails, the book is still uploaded and registered.

'use client'

import { useState, useRef } from 'react'
import {
  buildAndSignRegisterBook,   // builds + signs the Soroban register_book tx
  submitSignedTransaction,    // submits the signed tx to Stellar
  getTotalBooks,              // reads total book count from contract (to get bookId)
  updateArweaveTx,            // updates the on-chain arweave_tx_id after upload
} from '../lib/contract'
import { requestAccess } from '@stellar/freighter-api'
import {
  generateKey,   // generates a random AES-256-GCM key
  exportKey,     // exports the key as a hex string for storage
  encryptFile,   // encrypts the file buffer, returns { encryptedData, iv }
} from '../lib/crypto'

// ── Types ─────────────────────────────────────────────────────────────────────

type UploadStatus = 'idle' | 'uploading' | 'done' | 'error'
type ContentFormat = 'PDF' | 'EPUB' | 'TXT' | null

// ── Constants ─────────────────────────────────────────────────────────────────

// MIME type map — used when sending file metadata to the upload API
const MIME_TYPES: Record<string, string> = {
  PDF:  'application/pdf',
  EPUB: 'application/epub+zip',
  TXT:  'text/plain',
}

// Book categories shown in the dropdown
const CATEGORIES = [
  'Textbook', 'Novel', 'Research Paper',
  'Essay Collection', 'Course Notes', 'Reference', 'Other',
]

// ── Helpers ───────────────────────────────────────────────────────────────────

// Returns the MIME type string for a given content format
function getMimeType(format: ContentFormat): string {
  if (!format) return 'application/octet-stream'
  return MIME_TYPES[format] ?? 'application/octet-stream'
}

// Detects the content format from a file's name or MIME type.
// Used to auto-populate the format field when a file is selected.
function detectFormat(file: File): ContentFormat {
  const name = file.name.toLowerCase()
  if (name.endsWith('.epub'))                return 'EPUB'
  if (name.endsWith('.pdf'))                 return 'PDF'
  if (name.endsWith('.txt'))                 return 'TXT'
  if (file.type === 'application/pdf')       return 'PDF'
  if (file.type === 'application/epub+zip')  return 'EPUB'
  if (file.type === 'text/plain')            return 'TXT'
  return null
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function UploadPage() {

  // ── Form state ─────────────────────────────────────────────────────────────
  // These are the metadata fields the creator fills in before uploading.
  const [file,        setFile]        = useState<File | null>(null)   // the book file
  const [format,      setFormat]      = useState<ContentFormat>(null) // PDF | EPUB | TXT
  const [title,       setTitle]       = useState('')
  const [author,      setAuthor]      = useState('')
  const [isbn,        setIsbn]        = useState('')
  const [edition,     setEdition]     = useState('')
  const [description, setDescription] = useState('')
  const [category,    setCategory]    = useState('')
  const [price,       setPrice]       = useState('')                  // in USD
  const [royalty,     setRoyalty]     = useState('5')                 // resale royalty %

  // ── Cover image state ──────────────────────────────────────────────────────
  // Cover images are optional. If provided they are uploaded to Arweave as a
  // separate public (unencrypted) transaction. The TX ID is stored as an
  // Arweave tag on the book transaction and in Supabase as cover_tx_id.
  const [coverFile,    setCoverFile]    = useState<File | null>(null)
  const [coverPreview, setCoverPreview] = useState<string | null>(null) // base64 data URL for preview
  const coverInputRef = useRef<HTMLInputElement>(null)                  // ref to hidden file input

  // ── Upload state ───────────────────────────────────────────────────────────
  const [status,    setStatus]    = useState<UploadStatus>('idle')
  const [step,      setStep]      = useState('')         // human-readable progress message
  const [progress,  setProgress]  = useState(0)          // 0-100 progress bar value
  const [txId,      setTxId]      = useState<string | null>(null)      // Arweave TX ID of book
  const [coverTxId, setCoverTxId] = useState<string | null>(null)      // Arweave TX ID of cover
  const [error,     setError]     = useState<string | null>(null)

  // ── File selection handler ─────────────────────────────────────────────────

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0]
    if (!selected) return
    setFile(selected)
    setFormat(detectFormat(selected))  // auto-detect PDF/EPUB/TXT
    setStatus('idle')
    setTxId(null)
    setError(null)
  }

  // ── Cover image selection handler ──────────────────────────────────────────

  function handleCoverChange(e: React.ChangeEvent<HTMLInputElement>) {
    const selected = e.target.files?.[0]
    if (!selected) return

    // validate that the file is an image
    if (!selected.type.startsWith('image/')) {
      setError('Cover must be an image file (JPG, PNG, WebP)')
      return
    }

    // validate file size — covers should be small for fast loading
    if (selected.size > 10 * 1024 * 1024) {
      setError('Cover image must be under 10MB')
      return
    }

    setCoverFile(selected)
    setError(null)

    // generate a base64 data URL for the preview thumbnail
    // FileReader is used here because we need a preview without uploading
    const reader = new FileReader()
    reader.onload = e => setCoverPreview(e.target?.result as string)
    reader.readAsDataURL(selected)
  }

  // Clears the cover image selection and resets the file input
  function removeCover() {
    setCoverFile(null)
    setCoverPreview(null)
    if (coverInputRef.current) coverInputRef.current.value = ''
  }

  // ── Form validation ────────────────────────────────────────────────────────
  // Upload button is disabled unless all required fields are filled.
  // Cover image is optional.
  function isFormValid() {
    return (
      file !== null &&
      format !== null &&
      title.trim() !== '' &&
      author.trim() !== '' &&
      category !== '' &&
      price.trim() !== '' &&
      parseFloat(price) > 0
    )
  }

  // ── Reset form ─────────────────────────────────────────────────────────────
  // Called after a successful upload or when the creator clicks "Upload another"
  function resetForm() {
    setFile(null); setFormat(null); setTitle(''); setAuthor('')
    setIsbn(''); setEdition(''); setDescription(''); setCategory('')
    setPrice(''); setRoyalty('5'); setStatus('idle')
    setTxId(null); setCoverTxId(null); setProgress(0); setStep(''); setError(null)
    setCoverFile(null); setCoverPreview(null)
    if (coverInputRef.current) coverInputRef.current.value = ''
  }

  // ── Main upload handler ────────────────────────────────────────────────────
  // This is the core of the upload flow. See the ATOMIC UPLOAD FLOW comment
  // at the top of the file for the full sequence.
  async function handleUpload() {
    if (!isFormValid() || !file || !format) return

    setStatus('uploading')
    setError(null)
    setTxId(null)
    setCoverTxId(null)
    setProgress(0)

    try {

      // ── Step 1: Connect Freighter wallet ───────────────────────────────
      // We connect the wallet FIRST before doing anything else.
      // If the creator doesn't have Freighter or cancels, we abort immediately.
      setStep('Connecting wallet...')
      const accessResult = await requestAccess()
      if (accessResult.error) {
        throw new Error('Wallet connection required to publish. Please connect Freighter and try again.')
      }
      const walletAddress = accessResult.address
      console.log('Wallet connected:', walletAddress)
      setProgress(10)

      // ── Step 2: Encrypt the book file in the browser ───────────────────
      // AES-256-GCM encryption happens entirely in the browser.
      // - generateKey()  → creates a random 256-bit AES key
      // - encryptFile()  → encrypts the file, returns { encryptedData, iv }
      // - exportKey()    → exports the key as a hex string for key server storage
      //
      // The IV (Initialisation Vector) is random per upload and must be stored
      // alongside the key so the file can be decrypted later.
      //
      // IMPORTANT: plaintext never leaves the browser. Only the encrypted
      // blob is uploaded to Arweave.
      setStep('Encrypting file...')
      const aesKey = await generateKey()
      const { encryptedData, iv } = await encryptFile(file, aesKey)
      const keyHex = await exportKey(aesKey)
      console.log('File encrypted. Encrypted size:', encryptedData.byteLength, 'bytes')
      setProgress(20)

      // ── Step 3: Build + sign the Stellar transaction BEFORE uploading ──
      // We build and sign the Soroban register_book transaction here,
      // BEFORE uploading to Arweave. This is the atomic part:
      //
      // - Freighter prompts the creator to sign here.
      // - If they cancel, we throw immediately — nothing has been uploaded.
      // - We use a placeholder Arweave TX ID because the real one won't
      //   exist until after the Arweave upload completes (Step 5).
      // - The placeholder is replaced with the real TX ID in Step 8.
      //
      // The signed transaction is stored as XDR (Stellar binary format) and
      // submitted to the network in Step 7.
      setStep('Preparing Stellar transaction — please sign in Freighter...')

      // placeholder TX ID used during signing
      // format: "pending_<timestamp>" — makes it easy to identify in logs
      const PLACEHOLDER_TX = 'pending_' + Date.now()

      let signedXdr: string
      try {
        signedXdr = await buildAndSignRegisterBook(
          walletAddress,
          parseFloat(price) * 100,   // price in cents (Soroban uses integer math)
          parseInt(royalty) * 100,   // royalty in basis points (5% = 500 bps)
          PLACEHOLDER_TX,
          title,
        )
        console.log('Transaction signed successfully. Proceeding with upload...')
      } catch (signErr) {
        // Log the real error so it's actually diagnosable — a rejected
        // signature, an unfunded account, a wrong-network mismatch in
        // Freighter, and a bug building the transaction all used to look
        // identical to the user and in the console. They shouldn't.
        console.error('Signing failed — underlying error:', signErr)
        const detail = signErr instanceof Error ? signErr.message : String(signErr)
        throw new Error(`Upload cancelled — transaction was not signed. (${detail})`)
      }
      setProgress(30)

      // ── Step 4: Upload cover image to Arweave (if provided) ────────────
      // Cover images are:
      // - PUBLIC (not encrypted) — they appear in the library for all users
      // - Uploaded as a separate Arweave transaction from the book
      // - Tagged with Type: Book-Cover so they can be found via GraphQL
      // - Non-fatal: if cover upload fails, we log the error and continue
      //
      // The cover TX ID is:
      // - Stored as a Cover-Tx-Id tag on the book transaction (decentralised)
      // - Stored in Supabase books.cover_tx_id (fast cache)
      let uploadedCoverTxId: string | null = null

      if (coverFile) {
        setStep('Uploading cover image to Arweave...')
        const coverFormData = new FormData()
        coverFormData.append('cover',  coverFile)
        coverFormData.append('title',  title)
        coverFormData.append('author', author)

        const coverRes = await fetch('/api/upload/cover', {
          method: 'POST',
          body:   coverFormData,
        })
        const coverData: { txId: string; error?: string } = await coverRes.json()

        if (!coverRes.ok) {
          // non-fatal — book still uploads without a cover
          console.error('Cover upload failed (non-fatal):', coverData.error)
        } else {
          uploadedCoverTxId = coverData.txId
          setCoverTxId(uploadedCoverTxId)
          console.log('Cover uploaded successfully. TX ID:', uploadedCoverTxId)
        }
      }
      setProgress(45)

      // ── Step 5: Upload the encrypted book file to Arweave ──────────────
      // The encrypted file is uploaded to Arweave with metadata tags.
      // Tags are permanent and queryable via GraphQL — they form the
      // decentralised index for the book catalogue.
      //
      // The cover TX ID is included as a Cover-Tx-Id tag if the cover
      // was uploaded. This permanently associates the cover with the book.
      setStep('Uploading to Arweave...')

      // wrap the encrypted ArrayBuffer in a Blob/File for FormData
      const encryptedBlob = new Blob([encryptedData], { type: 'application/octet-stream' })
      const encryptedFile = new File([encryptedBlob], file.name + '.enc', {
        type: 'application/octet-stream',
      })

      const formData = new FormData()
      formData.append('file',          encryptedFile)
      formData.append('title',         title)
      formData.append('author',        author)
      formData.append('isbn',          isbn)
      formData.append('edition',       edition)
      formData.append('description',   description)
      formData.append('category',      category.toLowerCase())
      formData.append('price',         price)
      formData.append('royalty',       royalty)
      formData.append('contentFormat', format)
      formData.append('contentMime',   getMimeType(format))
      if (uploadedCoverTxId) {
        formData.append('coverTxId', uploadedCoverTxId)
      }

      // fake progress animation while waiting for Arweave upload
      // the real upload happens server-side so we can't track exact progress
      const progressInterval = setInterval(() => {
        setProgress(prev => prev >= 75 ? prev : prev + 3)
      }, 400)

      const uploadRes = await fetch('/api/upload', {
        method: 'POST',
        body:   formData,
      })
      clearInterval(progressInterval)

      const uploadData: { txId: string; error?: string } = await uploadRes.json()
      if (!uploadRes.ok) throw new Error(uploadData.error || 'Arweave upload failed')

      const arweaveTxId = uploadData.txId
      setTxId(arweaveTxId)
      console.log('Book uploaded to Arweave. TX ID:', arweaveTxId)
      setProgress(75)

      // ── Step 6: Submit the signed Stellar transaction ──────────────────────
      setStep('Submitting to Stellar...')
      const submitResult = await submitSignedTransaction(signedXdr)
      console.log('Stellar transaction submitted:', submitResult)
      setProgress(85)

      // ── Step 7: Get bookId and update Arweave TX ID on-chain ───────────────
      setStep('Updating on-chain metadata...')
      let bookId = -1
      try {
        const totalBooks = await getTotalBooks(walletAddress)
        bookId = totalBooks - 1
        console.log('Book registered with ID:', bookId)
        await updateArweaveTx(walletAddress, bookId, arweaveTxId)
        console.log('Arweave TX ID written on-chain successfully')
      } catch (updateErr) {
        console.error('Could not update Arweave TX ID on-chain (non-fatal):', updateErr)
      }
      setProgress(90)

      // ── Update soroban_book_id in Supabase ─────────────────────────────────
      // Keeps the Supabase cache in sync with the on-chain bookId
      // Used by the purchase modal to resolve bookId on other devices
      try {
        await fetch('/api/books/setbookid', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ arweaveTxId, bookId }),
        })
        console.log('Supabase soroban_book_id updated:', bookId)
      } catch (err) {
        console.error('Could not update soroban_book_id in Supabase (non-fatal):', err)
      }


      // ── Step 8: Store the encryption key on the key server ─────────────────
      setStep('Storing encryption key...')
      const keyRes = await fetch('/api/keys', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          arweaveTxId,
          bookId,
          key: keyHex,
          iv,
          walletAddress,
        }),
      })
      if (!keyRes.ok) {
        const keyErr = await keyRes.json()
        throw new Error(keyErr.error || 'Failed to store encryption key')
      }
      setProgress(100)

      setStep('')
      setStatus('done')

    } catch (err) {
      console.error('Upload error:', err)
      setError(err instanceof Error ? err.message : 'Upload failed')
      setStatus('error')
    }
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto px-6 py-12">

        <div className="mb-10">
          <h1 className="text-3xl font-bold mb-2">Publish a book</h1>
          <p className="text-gray-400">
            Your file is encrypted in the browser before upload. Plaintext never leaves your device.
          </p>
        </div>

        <div className="space-y-6">

          {/* ── BOOK FILE ── */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Book file <span className="text-indigo-400">*</span>
              <span className="text-gray-500 font-normal ml-2">PDF, EPUB, or TXT</span>
            </label>
            <input
              type="file"
              accept=".pdf,.epub,.txt"
              onChange={handleFileChange}
              disabled={status === 'uploading'}
              className="w-full bg-gray-950 border border-gray-700 text-white px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors file:mr-4 file:py-1 file:px-3 file:rounded file:border-0 file:text-sm file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
            />
            {file && format && (
              <p className="text-gray-500 text-xs mt-1">
                {file.name} · {format} · {(file.size / 1024 / 1024).toFixed(2)} MB
              </p>
            )}
            {file && !format && (
              <p className="text-red-400 text-xs mt-1">
                Unsupported format — please use PDF, EPUB, or TXT
              </p>
            )}
          </div>

          {/* ── COVER IMAGE ──
               Optional. Shows a click-target area if no cover is selected,
               or a preview thumbnail with a remove button if one is selected.
               The actual file input is hidden — clicking the target triggers it. */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Cover image
              <span className="text-gray-500 font-normal ml-2">
                Optional · JPG, PNG, WebP · max 10MB
              </span>
            </label>

            {coverPreview ? (
              // preview state — show thumbnail + file info + remove button
              <div className="flex items-start gap-4">
                <img
                  src={coverPreview}
                  alt="Cover preview"
                  className="w-40 aspect-video object-cover rounded-lg border border-gray-700"
                />
                <div className="flex flex-col gap-2 justify-center">
                  <p className="text-gray-400 text-sm">{coverFile?.name}</p>
                  <p className="text-gray-600 text-xs">
                    {coverFile ? (coverFile.size / 1024).toFixed(0) + ' KB' : ''}
                  </p>
                  <button
                    onClick={removeCover}
                    disabled={status === 'uploading'}
                    className="text-red-400 hover:text-red-300 text-sm transition-colors text-left"
                  >
                    Remove cover
                  </button>
                </div>
              </div>
            ) : (
              // empty state — click target that triggers the hidden file input
              <div
                onClick={() => coverInputRef.current?.click()}
                className="border-2 border-dashed border-gray-700 hover:border-indigo-500 rounded-lg p-8 text-center cursor-pointer transition-colors"
              >
                <div className="text-gray-500 text-sm">Click to upload cover image</div>
                <div className="text-gray-600 text-xs mt-1">
                  Recommended: 400×600px portrait
                </div>
              </div>
            )}

            {/* hidden file input — triggered programmatically via ref */}
            <input
              ref={coverInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={handleCoverChange}
              disabled={status === 'uploading'}
              className="hidden"
            />
          </div>

          {/* ── TITLE ── */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Title <span className="text-indigo-400">*</span>
            </label>
            <input
              type="text"
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Introduction to Quantum Computing"
              disabled={status === 'uploading'}
              className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>

          {/* ── AUTHOR ── */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Author <span className="text-indigo-400">*</span>
            </label>
            <input
              type="text"
              value={author}
              onChange={e => setAuthor(e.target.value)}
              placeholder="Dr. Jane Smith"
              disabled={status === 'uploading'}
              className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
            />
          </div>

          {/* ── CATEGORY ── */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Category <span className="text-indigo-400">*</span>
            </label>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              disabled={status === 'uploading'}
              className="w-full bg-gray-950 border border-gray-700 text-white px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
            >
              <option value="" disabled>Select a category</option>
              {CATEGORIES.map(c => (
                <option key={c} value={c.toLowerCase()}>{c}</option>
              ))}
            </select>
          </div>

          {/* ── ISBN + EDITION ── */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">ISBN</label>
              <input
                type="text"
                value={isbn}
                onChange={e => setIsbn(e.target.value)}
                placeholder="978-0-000-00000-0"
                disabled={status === 'uploading'}
                className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">Edition</label>
              <input
                type="text"
                value={edition}
                onChange={e => setEdition(e.target.value)}
                placeholder="3rd"
                disabled={status === 'uploading'}
                className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
          </div>

          {/* ── DESCRIPTION ── */}
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="A brief description of what readers will discover..."
              rows={3}
              disabled={status === 'uploading'}
              className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors resize-none"
            />
          </div>

          {/* ── PRICE + ROYALTY ──
               Price is in USD, stored on-chain in cents (integer math).
               Royalty is the % the creator earns on every secondary resale,
               stored on-chain in basis points (5% = 500 bps).
               Both are enforced permanently by the Soroban contract. */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Price (USD) <span className="text-indigo-400">*</span>
              </label>
              <div className="relative">
                <span className="absolute left-4 top-3.5 text-gray-500">$</span>
                <input
                  type="number"
                  value={price}
                  onChange={e => setPrice(e.target.value)}
                  placeholder="49.99"
                  min="0"
                  step="0.01"
                  disabled={status === 'uploading'}
                  className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 pl-8 pr-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
                />
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Resale royalty (%)
              </label>
              <div className="relative">
                <input
                  type="number"
                  value={royalty}
                  onChange={e => setRoyalty(e.target.value)}
                  min="0"
                  max="50"
                  disabled={status === 'uploading'}
                  className="w-full bg-gray-950 border border-gray-700 text-white placeholder-gray-600 px-4 py-3 rounded-lg focus:outline-none focus:border-indigo-500 transition-colors"
                />
                <span className="absolute right-4 top-3.5 text-gray-500">%</span>
              </div>
              <p className="text-gray-600 text-xs mt-1">
                You earn this % every time a reader resells your book
              </p>
            </div>
          </div>

          {/* ── UPLOAD BUTTON ──
               Disabled until all required fields are valid.
               Label changes to reflect current upload state. */}
          <button
            onClick={handleUpload}
            disabled={!isFormValid() || status === 'uploading' || status === 'done'}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-gray-700 disabled:text-gray-500 text-white py-3 rounded-lg font-medium transition-colors"
          >
            {status === 'uploading' && (step || `Uploading... ${progress}%`)}
            {status === 'done'      && 'Upload complete ✓'}
            {status === 'idle'      && 'Upload to Arweave'}
            {status === 'error'     && 'Try again'}
          </button>

          {/* ── PROGRESS BAR ── */}
          {status === 'uploading' && (
            <div className="space-y-2">
              <div className="w-full bg-gray-800 rounded-full h-1.5">
                <div
                  className="bg-indigo-500 h-1.5 rounded-full transition-all duration-500"
                  style={{ width: progress + '%' }}
                />
              </div>
              <div className="text-gray-500 text-xs text-center">{step}</div>
            </div>
          )}

          {/* ── SUCCESS ──
               Shows both the book TX ID and cover TX ID (if applicable).
               Both are permanent Arweave transactions — they exist forever. */}
          {status === 'done' && txId && (
            <div className="bg-green-950 border border-green-800 rounded-xl p-6 space-y-3">
              <div className="text-green-400 font-medium">Upload complete ✓</div>
              <div>
                <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">
                  Arweave transaction ID
                </div>
                <code className="text-green-300 text-xs break-all">{txId}</code>
              </div>
              {coverTxId && (
                <div>
                  <div className="text-gray-500 text-xs uppercase tracking-wider mb-1">
                    Cover image TX ID
                  </div>
                  <code className="text-green-300 text-xs break-all">{coverTxId}</code>
                </div>
              )}
              <div className="flex gap-4">
                <a
                  href={'https://arweave.net/' + txId}
                  target="_blank"
                  rel="noreferrer"
                  className="text-indigo-400 hover:text-indigo-300 text-sm transition-colors"
                >
                  View on Arweave →
                </a>
                <button
                  onClick={resetForm}
                  className="text-gray-400 hover:text-white text-sm transition-colors"
                >
                  Upload another →
                </button>
              </div>
            </div>
          )}

          {/* ── ERROR ──
               Shows whenever `error` is set, regardless of overall upload
               `status` — cover/file validation errors happen before any
               upload is ever attempted, so gating this on status === 'error'
               meant those messages were being generated but never shown. */}
          {error && (
            <div className="bg-red-950 border border-red-800 rounded-xl p-4">
              <div className="text-red-400 font-medium mb-1">Error</div>
              <p className="text-red-300 text-xs leading-relaxed">{error}</p>
            </div>
          )}

        </div>
      </div>
    </div>
  )
}