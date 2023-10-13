"use client"

import {
  Relay,
  relayInit,
  VerifiedEvent,
  generatePrivateKey,
} from "nostr-tools"
import { FaGithub, FaExternalLinkAlt } from "react-icons/fa"
import { useEffect, useState } from "react"
import { WebLNProvider, requestProvider } from "webln"
import {
  AnnouncementNote,
  CreateNotePostBody,
  GatedNote,
  KeyNote,
  NIP_108_KINDS,
  createAnnouncementNoteUnsigned,
  createGatedNoteUnsigned,
  eventToAnnouncementNote,
  eventToGatedNote,
  eventToKeyNote,
  unlockGatedNote,
  PREntry,
} from "nip108"

const RELAY = process.env.NEXT_PUBLIC_NOSTR_RELAY as string
const GATE_SERVER = process.env.NEXT_PUBLIC_GATE_SERVER as string

const MIN_PREVIEW_LENGTH = Number(process.env.NEXT_PUBLIC_MIN_PREVIEW_LENGTH)
const MAX_PREVIEW_LENGTH = Number(process.env.NEXT_PUBLIC_MAX_PREVIEW_LENGTH)

const MIN_CONTENT_LENGTH = Number(process.env.NEXT_PUBLIC_MIN_CONTENT_LENGTH)
const MAX_CONTENT_LENGTH = Number(process.env.NEXT_PUBLIC_MAX_CONTENT_LENGTH)

const MIN_SAT_COST = Number(process.env.NEXT_PUBLIC_MIN_SAT_COST)
const MAX_SAT_COST = Number(process.env.NEXT_PUBLIC_MAX_SAT_COST)

const NOSTR_FETCH_LIMIT = Number(process.env.NEXT_PUBLIC_NOSTR_FETCH_LIMIT)

interface FormData {
  lud16: string
  cost?: number
  preview: string
  content: string
}
const DEFAULT_FORM_DATA: FormData = {
  lud16: "coachchuckff@getalby.com",
  cost: 1,
  preview: "Hey unlock my post for 1 sat!",
  content: "This is the content that will be unlocked!",
}

export default function Home() {
  // ------------------- STATES -------------------------

  const [gateLoading, setGateLoading] = useState<string | null>()
  const [relay, setRelay] = useState<Relay | null>(null)
  const [nostr, setNostr] = useState<any | null>(null)
  const [publicKey, setPublicKey] = useState<string | null>(null)
  const [webln, setWebln] = useState<null | WebLNProvider>(null)
  const [announcementNotes, setAnnouncementNotes] = useState<
    AnnouncementNote[]
  >([])
  const [gatedNotes, setGatedNotes] = useState<GatedNote[]>([])
  const [keyNotes, setKeyNotes] = useState<KeyNote[]>([])

  const [submittingForm, setSubmittingForm] = useState<boolean>(false)
  const [isPostFormOpen, setPostFormOpen] = useState<boolean>(false)
  const [formData, setFormData] = useState<FormData>(DEFAULT_FORM_DATA)

  // ------------------- EFFECTS -------------------------

  useEffect(() => {
    requestProvider()
      .then(setWebln)
      .catch(e => {
        alert("Please download Alby or ZBD to use this app.")
      })
  }, [])

  useEffect(() => {
    if ((window as any).nostr) {
      setNostr((window as any).nostr)
      ;(window as any).nostr.getPublicKey().then(setPublicKey)
    } else {
      alert("Nostr not found")
    }
  }, [])

  useEffect(() => {
    const newRelay = relayInit(RELAY)
    newRelay.on("connect", () => {
      setRelay(newRelay)
    })
    newRelay.connect()

    return () => {
      newRelay.close()
    }
  }, [])

  useEffect(() => {
    if (relay && nostr && publicKey) {
      relay
        .list([
          {
            kinds: [NIP_108_KINDS.announcement],
            limit: NOSTR_FETCH_LIMIT,
          },
          {
            kinds: [NIP_108_KINDS.key],
            limit: NOSTR_FETCH_LIMIT,
            authors: [publicKey as string],
          },
        ])
        .then(notes => {
          const newAnnouncementNotes: AnnouncementNote[] = []
          const newKeyNotes: KeyNote[] = []

          for (const note of notes) {
            if (
              note.kind === NIP_108_KINDS.announcement &&
              note.tags.find(tag => tag[0] === "g")
            ) {
              newAnnouncementNotes.push(
                eventToAnnouncementNote(note as VerifiedEvent)
              )
            } else if (note.kind === NIP_108_KINDS.key) {
              newKeyNotes.push(eventToKeyNote(note as VerifiedEvent))
            }
          }

          setAnnouncementNotes(newAnnouncementNotes)
          setKeyNotes(newKeyNotes)

          relay
            .list([
              {
                ids: [
                  ...newAnnouncementNotes.map(
                    announcementNote => announcementNote.gate
                  ),
                  ...newKeyNotes.map(keyNote => keyNote.gate),
                ],
              },
            ])
            .then(gatedEvents => {
              console.log(gatedEvents)
              setGatedNotes(
                gatedEvents.map(gatedNote =>
                  eventToGatedNote(gatedNote as VerifiedEvent)
                )
              )
            })
        })
    }
  }, [relay, nostr, publicKey])

  useEffect(() => {
    if (gatedNotes.length > 0) {
      unlockAll()
    }
  }, [gatedNotes])

  // ------------------- FUNCTIONS -------------------------

  const unlockAll = async () => {
    const newKeyNotes: KeyNote[] = []
    for (const keyNote of keyNotes) {
      const gatedNote = gatedNotes.find(
        gatedNote => gatedNote.note.id === keyNote.gate
      )

      if (!gatedNote) {
        newKeyNotes.push(keyNote)
        continue
      }

      const unlockedSecret = await nostr.nip04.decrypt(
        gatedNote.note.pubkey,
        keyNote.note.content
      )

      newKeyNotes.push({
        ...keyNote,
        unlockedSecret,
      })
    }

    setKeyNotes(newKeyNotes)
  }

  const handleBuy = async (gatedNote: GatedNote) => {
    if (gateLoading) return

    setGateLoading(gatedNote.note.id)

    try {
      if (!webln) throw new Error("No webln provider")
      if (!nostr) throw new Error("No nostr provider")
      if (!publicKey) throw new Error("No Public Key")
      if (!relay) throw new Error("No relay")

      const uri = `${gatedNote.endpoint}/${gatedNote.note.id}`
      const invoiceResponse = await fetch(uri)
      const invoiceResponseJson = (await invoiceResponse.json()) as PREntry

      await webln.sendPayment(invoiceResponseJson.pr)

      const resultResponse = await fetch(invoiceResponseJson.successAction.url)
      const resultResponseJson = await resultResponse.json()
      const secret = resultResponseJson.secret

      const content = await nostr.nip04.encrypt(gatedNote.note.pubkey, secret)

      const keyEvent = {
        kind: NIP_108_KINDS.key,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [["g", gatedNote.note.id]],
        content: content,
      }

      const keyEventVerified = await nostr.signEvent(keyEvent)

      await relay.publish(keyEventVerified)

      const keyNoteUnlocked = {
        ...eventToKeyNote(keyEventVerified),
        unlockedSecret: secret,
      } as KeyNote
      setKeyNotes([...keyNotes, keyNoteUnlocked])
    } catch (e) {
      alert(e)
    }

    setGateLoading(null)
  }

  const formatGatedContent = (content: string) => {
    return content.substring(0, 500) + "..."
  }

  const submitForm = async () => {
    if (submittingForm) return

    setSubmittingForm(true)

    try {
      if (!webln) throw new Error("No webln provider")
      if (!nostr) throw new Error("No nostr provider")
      if (!publicKey) throw new Error("No Public Key")
      if (!relay) throw new Error("No relay")

      // ------------------- VALIDATE FORM -------------------------
      const { lud16, cost, preview, content } = formData

      // 1. Check if lud16 is valid (looks like an email)
      const emailRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/
      if (!emailRegex.test(lud16)) throw new Error("Invalid lud16 format")

      // 2. Check if price is valid
      if (!cost || cost < MIN_SAT_COST || cost > MAX_SAT_COST)
        throw new Error(
          `Price should be >= ${MIN_SAT_COST} and <= ${MAX_SAT_COST} sats`
        )
      const unlockCost = cost * 1000

      // 3. Check if preview is valid
      if (
        preview.length > MAX_PREVIEW_LENGTH ||
        preview.length < MIN_PREVIEW_LENGTH
      )
        throw new Error(
          `Preview should be <= 260 chars and >= ${MIN_PREVIEW_LENGTH} chars`
        )

      // 4. Check if content is valid
      if (
        content.length > MAX_CONTENT_LENGTH ||
        content.length < MIN_CONTENT_LENGTH
      )
        throw new Error(
          `Content should be <= ${MAX_CONTENT_LENGTH} chars and >= ${MIN_CONTENT_LENGTH} chars`
        )

      // ------------------- CREATE LOCKED CONTENT -------------------------

      const lockedContent = {
        kind: 1,
        pubkey: publicKey,
        created_at: Math.floor(Date.now() / 1000),
        tags: [],
        content: content,
      }
      const lockedContentVerified = await nostr.signEvent(lockedContent)

      const secret = generatePrivateKey()
      const gatedNote = createGatedNoteUnsigned(
        publicKey,
        secret,
        unlockCost,
        GATE_SERVER,
        lockedContentVerified
      )

      const gatedNoteVerified = await nostr.signEvent(gatedNote)

      const postBody: CreateNotePostBody = {
        gateEvent: gatedNoteVerified,
        lud16: lud16,
        secret: secret,
        cost: unlockCost,
      }

      const response = await fetch(GATE_SERVER + "/create", {
        method: "POST",
        headers: {
          "Content-type": "application/json",
        },
        body: JSON.stringify(postBody),
      })

      const responseJson = await response.json()
      console.log(responseJson)

      console.log("Publishing Gated Note...")
      await relay.publish(gatedNoteVerified)

      // ------------------- CREATE ANNOUNCEMENT NOTE -------------------------

      const announcementNote = createAnnouncementNoteUnsigned(
        publicKey,
        preview,
        gatedNoteVerified
      )

      console.log("Publishing Announcement Note...")
      const announcementNoteVerified = await nostr.signEvent(announcementNote)
      await relay.publish(announcementNoteVerified)

      // ------------------- ADD NOTE TO EVENTS -------------------------

      console.log("Adding Notes to Events...")
      setAnnouncementNotes([
        eventToAnnouncementNote(announcementNoteVerified),
        ...announcementNotes,
      ])
      setGatedNotes([eventToGatedNote(gatedNoteVerified), ...gatedNotes])
    } catch (e) {
      alert(e)
      console.log(e)
    }

    setSubmittingForm(false)
    setFormData(DEFAULT_FORM_DATA)
    setPostFormOpen(false)
  }

  // ------------------- RENDERERS -------------------------
  const renderHeader = () => {
    return (
      <h3 className="bg-black text-2xl font-bold fixed h-20 max-w-3xl flex items-center w-full justify-center">
        RELAY: {RELAY}
      </h3>
    )
  }

  const renderUnlockedContent = (gatedNote: GatedNote, keyNote: KeyNote) => {
    const unlockedNote = unlockGatedNote(
      gatedNote.note,
      keyNote.unlockedSecret as string
    )

    return (
      <div className="mt-5">
        <p>🔓 {unlockedNote.content}</p>
      </div>
    )
  }

  const renderLockedContent = (gatedNote: GatedNote) => {
    return (
      <div className="mt-5">
        <p className="blur-sm break-words select-none">
          {formatGatedContent(gatedNote.note.content)}
        </p>
        <div className="mt-4 flex justify-center">
          <button
            onClick={() => {
              handleBuy(gatedNote)
            }}
            className={`px-3 py-2 border border-r-4 border-white rounded-full text-white hover:bg-white hover:text-black hover:border-black`}>
            {gateLoading && gatedNote.note.id === gateLoading
              ? "Unlocking..."
              : `${(gatedNote.cost / 1000).toFixed(0)} ⚡🔓`}
          </button>
        </div>
      </div>
    )
  }

  const renderGatedContent = (event: AnnouncementNote) => {
    const gatedNote = gatedNotes.find(
      gatedNote => gatedNote.note.id === event.gate
    )
    const keyNote = keyNotes.find(
      keyNote => keyNote.gate === event.gate && keyNote.unlockedSecret
    )

    if (!gatedNote) return null

    if (keyNote) return renderUnlockedContent(gatedNote, keyNote)

    return renderLockedContent(gatedNote)
  }

  const renderEvents = () => {
    return (
      <div className="w-full mt-20 space-y-4">
        {announcementNotes.map((event, index) => {
          return (
            <div
              key={index}
              className="flex flex-col px-12 py-4 border border-white/20 rounded-md">
              {/* This container ensures content wrapping */}
              <div className="flex-grow overflow-hidden">
                <p className="text-xs mb-1">ID: {event.note.id}</p>
                <p className="text-xs mb-5">Author: {event.note.pubkey} </p>

                <h3 className="break-words">{event.note.content}</h3>
              </div>
              {/* Button with a thin white outline */}
              {renderGatedContent(event)}
            </div>
          )
        })}
      </div>
    )
  }

  const renderForm = () => {
    if (!isPostFormOpen) return null

    return (
      <div className="fixed top-0 left-0 w-full h-full flex items-center justify-center bg-opacity-60 bg-black z-50">
        <div className="bg-black border-2 border-white p-5 rounded-lg shadow-lg w-1/2 text-white">
          <h2 className="mb-4 text-lg">Create Gated Post</h2>
          <div className="mt-1 mb-2">
            <label className="block mb-2">Lud16</label>
            <input
              type="email"
              placeholder="coachchuckff@getalby.com"
              value={formData.lud16}
              onChange={e =>
                setFormData({ ...formData, lud16: e.target.value })
              }
              className="p-2 w-full border border-white bg-black text-white rounded"
            />
          </div>
          <div className="mt-1 mb-2">
            <label className="block mb-2">Unlock Cost ( sats )</label>
            <input
              type="number"
              min={`${MIN_SAT_COST}`}
              max={`${MAX_SAT_COST}`}
              value={formData.cost}
              onChange={e =>
                setFormData({ ...formData, cost: +e.target.value })
              }
              className="p-2 w-full border border-white bg-black text-white rounded"
            />
          </div>
          <div className="mt-1 mb-2">
            <label className="block mb-2">Preview</label>
            <input
              type="text"
              placeholder={`Hey unlock my post for ${formData.cost} sats!`}
              maxLength={MAX_PREVIEW_LENGTH}
              value={formData.preview}
              onChange={e =>
                setFormData({ ...formData, preview: e.target.value })
              }
              className="p-2 w-full border border-white bg-black text-white rounded"
            />
          </div>
          <div className="mt-1 mb-2">
            <label className="block mb-2">Content</label>
            <textarea
              maxLength={MAX_CONTENT_LENGTH}
              placeholder={`This is the content that will be unlocked!`}
              value={formData.content}
              onChange={e =>
                setFormData({ ...formData, content: e.target.value })
              }
              className="p-2 w-full border border-white bg-black text-white rounded"></textarea>
          </div>
          <div className="mt-4 flex justify-between">
            <button
              onClick={() => setPostFormOpen(false)}
              className="px-4 py-2 bg-black border border-white text-white rounded hover:bg-white hover:text-black">
              Close
            </button>
            <button
              onClick={submitForm}
              className="px-4 py-2 bg-black border border-white text-white rounded hover:bg-white hover:text-black">
              Submit
            </button>
          </div>
        </div>
      </div>
    )
  }

  const renderPostButton = () => {
    return (
      <button
        onClick={() => setPostFormOpen(true)}
        className="fixed bottom-8 right-8 px-6 py-3 rounded-full border border-white/20 font-bold text-white shadow-lg bg-black hover:bg-white hover:text-black"
        style={{ zIndex: 1000 }}>
        Post
      </button>
    )
  }

  const renderSocials = () => {
    return (
      <div className="fixed top-5 right-5 flex space-x-5 z-50">
        <a
          href="https://github.com/project-excalibur/NIP-108"
          target="_blank"
          rel="noopener noreferrer">
          <FaGithub className="text-white hover:text-gray-400" size={24} />
        </a>
        <a
          href="https://nostrplayground.com"
          target="_blank"
          rel="noopener noreferrer">
          <FaExternalLinkAlt
            className="text-white hover:text-gray-400"
            size={24}
          />
        </a>
      </div>
    )
  }

  const renderUserMenu = () => {
    return (
      <div className=" flex-col gap-4 text-xl font-bold w-40  mt-20 p-4 hidden md:block fixed left-0">
        <p>Zapz Life</p>
        <p className="mt-10">Home</p>
        <p>Explore</p>
        <p>Settings</p>
      </div>
    )
  }

  const renderSearchBar = () => {
    return (
      <input
        type="text"
        placeholder="search"
        className=" h-4 p-4 rounded-full bg-transparent border-white/20 border outline-none"
      />
    )
  }

  const mockTrendingPosts = () => {
    let i = 0
    const elements = []

    while (i < 30) {
      elements.push(
        <div key={i} className="flex mt-4 gap-2 h-12">
          <img
            src="https://placebeard.it/640x360"
            className="w-8 rounded-full h-8 object-cover"
            alt=""
          />
          <div className="flex flex-col ">
            <p className="font-bold text-sm">
              User<span className="font-thin"> | 1h ago</span>
            </p>
            <p className="font-thin line-clamp-2 text-xs">
              Lorem ipsum dolor sit amet consectetur adipisicing elit.
            </p>
          </div>
        </div>
      )

      i++
    }

    return <div>{elements}</div>
  }

  const renderTrending = () => {
    return (
      <div className="flex flex-col h-screen">
        <p>TRENDING</p>
        <div id="trendingPosts" className="overflow-scroll h-[50vh] pb-10 mt-4">
          {mockTrendingPosts()}
        </div>
      </div>
    )
  }

  // ------------------- MAIN -------------------------

  return (
    <main className="flex w-full justify-center ">
      {renderUserMenu()}
      <div className="flex min-h-screen flex-col items-center max-w-xl xl:max-w-2xl overflow-y-scroll">
        {/* {renderHeader()} */}
        {/* {renderEvents()} */}
        {/* MOCK POSTs */}
        <div className="flex flex-col gap-4 mt-20">
          <div className="flex flex-col px-12 py-4 border border-white/20 rounded-md">
            {/* This container ensures content wrapping */}
            <div className="flex-grow overflow-hidden">
              <p className="text-xs mb-1">ID: 123123123</p>
              <p className="text-xs mb-5">Author: 123123123 </p>

              <h3 className="break-words">
                Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque.
              </h3>
            </div>
            {/* Button with a thin white outline */}
          </div>
          <div className="flex flex-col px-12 py-4 border border-white/20 rounded-md">
            {/* This container ensures content wrapping */}
            <div className="flex-grow overflow-hidden">
              <p className="text-xs mb-1">ID: 123123123</p>
              <p className="text-xs mb-5">Author: 123123123 </p>

              <h3 className="break-words">
                Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque.Lorem ipsum dolor sit amet
                consectetur adipisicing elit. Corrupti, aperiam rem. Molestias,
                hic recusandae repudiandae nisi quisquam ad quod voluptates,
                fugiat sed, id consequuntur. Cum sint maiores fugit aliquid
                cumque.Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque.Lorem ipsum dolor sit amet
                consectetur adipisicing elit. Corrupti, aperiam rem. Molestias,
                hic recusandae repudiandae nisi quisquam ad quod voluptates,
                fugiat sed, id consequuntur. Cum sint maiores fugit aliquid
                cumque.
              </h3>
            </div>
            {/* Button with a thin white outline */}
          </div>
          <div className="flex flex-col px-12 py-4 border border-white/20 rounded-md">
            {/* This container ensures content wrapping */}
            <div className="flex-grow overflow-hidden">
              <p className="text-xs mb-1">ID: 123123123</p>
              <p className="text-xs mb-5">Author: 123123123 </p>

              <h3 className="break-words">
                Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque. Lorem ipsum dolor sit
                amet consectetur adipisicing elit. Corrupti, aperiam rem.
                Molestias, hic recusandae repudiandae nisi quisquam ad quod
                voluptates, fugiat sed, id consequuntur. Cum sint maiores fugit
                aliquid cumque.Lorem ipsum dolor sit amet consectetur
                adipisicing elit. Corrupti, aperiam rem. Molestias, hic
                recusandae repudiandae nisi quisquam ad quod voluptates, fugiat
                sed, id consequuntur. Cum sint maiores fugit aliquid
                cumque.Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque.
              </h3>
            </div>
            {/* Button with a thin white outline */}
          </div>
          <div className="flex flex-col px-12 py-4 border border-white/20 rounded-md">
            {/* This container ensures content wrapping */}
            <div className="flex-grow overflow-hidden">
              <p className="text-xs mb-1">ID: 123123123</p>
              <p className="text-xs mb-5">Author: 123123123 </p>

              <h3 className="break-words">
                Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque.
              </h3>
            </div>
            {/* Button with a thin white outline */}
          </div>
          <div className="flex flex-col px-12 py-4 border border-white/20 rounded-md">
            {/* This container ensures content wrapping */}
            <div className="flex-grow overflow-hidden">
              <p className="text-xs mb-1">ID: 123123123</p>
              <p className="text-xs mb-5">Author: 123123123 </p>

              <h3 className="break-words">
                Lorem ipsum dolor sit amet consectetur adipisicing elit.
                Corrupti, aperiam rem. Molestias, hic recusandae repudiandae
                nisi quisquam ad quod voluptates, fugiat sed, id consequuntur.
                Cum sint maiores fugit aliquid cumque.
              </h3>
            </div>
            {/* Button with a thin white outline */}
          </div>
        </div>
        {/* MOCK POSTs */}
        {renderPostButton()}
        {renderForm()}
        {renderSocials()}
      </div>
      <div className="flex-col mt-20 ml-10 gap-8 space-y-8  w-60 hidden lg:block fixed right-0">
        {renderSearchBar()}
        {renderTrending()}
      </div>
    </main>
  )
}
