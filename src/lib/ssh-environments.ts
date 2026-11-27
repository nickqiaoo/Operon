import { queryOptions } from '@tanstack/react-query'
import type { SshEnvironmentProfile, SshHostKeyChallenge } from '@shared/ssh-environment'
import { request } from './api-client'
import { sshEnvironmentKeys } from './ssh-environment-queries'

const endpoint = '/ssh-environments'
export type SshEnvironmentInput = Omit<SshEnvironmentProfile, 'id'> & { password?: string }

export const sshEnvironmentsQuery = queryOptions({
  queryKey: sshEnvironmentKeys.all,
  queryFn: () => request<SshEnvironmentProfile[]>(endpoint),
  staleTime: 30_000,
})

export function saveSshEnvironment(id: string, profile: SshEnvironmentInput) {
  return request<SshEnvironmentProfile | SshHostKeyChallenge>(`${endpoint}/${id}`, {
    method: 'PUT',
    body: JSON.stringify(profile),
  })
}

export function deleteSshEnvironment(id: string) {
  return request<{ success: boolean }>(`${endpoint}/${id}`, { method: 'DELETE' })
}

export function testSshEnvironment(id: string, profile: SshEnvironmentInput) {
  return request<{ success: true; fingerprint: string } | SshHostKeyChallenge>(`${endpoint}/test`, {
    method: 'POST',
    body: JSON.stringify({ ...profile, id }),
  })
}
