import { createStore, produce } from 'solid-js/store'
import type { Email } from '../types/models'
import { appActions } from './app'

export interface EmailState {
  emails: Email[]
  selectedEmailId: string | null
  loading: boolean
}

const initialEmailState: EmailState = {
  emails: [],
  selectedEmailId: null,
  loading: false,
}

const [emailState, setEmailState] = createStore<EmailState>(initialEmailState)

export function useEmailStore() {
  return emailState
}

export const emailActions = {
  setEmails(emails: Email[]) {
    setEmailState('emails', emails)
  },

  addEmail(email: Email) {
    setEmailState('emails', produce((emails) => {
      const idx = emails.findIndex(e => e.id === email.id)
      if (idx >= 0) {
        emails[idx] = email
      } else {
        emails.unshift(email)
      }
    }))
  },

  markAsRead(emailId: string) {
    setEmailState('emails', (e) => e.id === emailId, 'read', true)
    // Update unread count in app store
    const unreadCount = emailState.emails.filter(e => !e.read).length
    appActions.setEmailUnreadCount(unreadCount)
  },

  setSelectedEmail(emailId: string | null) {
    setEmailState('selectedEmailId', emailId)
  },

  setLoading(loading: boolean) {
    setEmailState('loading', loading)
  },

  // Link an email to a session
  linkSession(emailId: string, sessionId: string) {
    setEmailState('emails', (e) => e.id === emailId, 'sessionId', sessionId)
  },
}
