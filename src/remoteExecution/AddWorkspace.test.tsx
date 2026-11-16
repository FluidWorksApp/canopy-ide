import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('./client', async importOriginal => ({ ...await importOriginal<typeof import('./client')>(), RemoteExecutionClient: class { list() { return mocks.list(); } } }));
vi.mock('./ManagedWorkspaces', () => ({ ManagedWorkspaces: () => null }));
vi.mock('./CreateWorkspace', () => ({ CreateWorkspace: () => <p>cloud form</p> }));
import { AddWorkspace } from './AddWorkspace';

const TOKEN = 'synthetic-token-0123456789abcdef';
const LINK = `http://box.tail1234.ts.net:8787/connect#token=${TOKEN}`;
const ws = (id: string, root?: string) => ({ id, name: id, accounts: [], memoryMiB: 512, cpus: 1, ...(root ? { root } : {}) });
afterEach(() => { cleanup(); mocks.list.mockReset(); });

function machineTab(onOpen = vi.fn().mockResolvedValue(undefined)) {
  render(<AddWorkspace onCancel={() => {}} onCreated={() => {}} onOpen={onOpen}/>);
  expect(screen.getByText('cloud form')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: 'Your own machine' }));
  const field = screen.getByLabelText('Paste the link it prints') as HTMLInputElement;
  return { onOpen, field };
}

it('opens a machine with one workspace under the machine name, with the token hidden', async () => {
  mocks.list.mockResolvedValue({ host: 'box', workspaces: [ws('work', '/home/me/work')] });
  const { onOpen, field } = machineTab();
  fireEvent.change(field, { target: { value: LINK } });
  expect(field.value).toBe('http://box.tail1234.ts.net:8787/connect#token=••••••••••••');
  expect(screen.getByText('✓ box.tail1234.ts.net · over Tailscale')).toBeInTheDocument();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'work', name: 'box' }), { endpoint: 'http://box.tail1234.ts.net:8787', token: TOKEN }, false);
});

it('asks which workspace when the machine has several', async () => {
  mocks.list.mockResolvedValue({ host: 'box', workspaces: [ws('work', '/home/me/work'), ws('api', '/home/me/api')] });
  const { onOpen, field } = machineTab();
  fireEvent.change(field, { target: { value: LINK } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
  expect(screen.getByText('Which workspace do you want to open?')).toBeInTheDocument();
  expect(screen.getByText('/home/me/api')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('radio', { name: /api/ }));
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Open' })); });
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'api', name: 'box · api' }), expect.anything(), false);
});

it('says plainly when the machine rejects the link', async () => {
  mocks.list.mockRejectedValue(new Error('Unauthorized'));
  const { onOpen, field } = machineTab();
  fireEvent.change(field, { target: { value: LINK } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Connect' })); });
  expect(screen.getByRole('alert')).toHaveTextContent("The machine didn't accept this link.");
  expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(onOpen).not.toHaveBeenCalled();
});

it('starts over when a link with a hidden token is edited', () => {
  const { field } = machineTab();
  fireEvent.change(field, { target: { value: LINK } });
  fireEvent.change(field, { target: { value: 'http://box.tail1234.ts.net:8787/connect#token=•••••••••••' } });
  expect(field.value).toBe('');
});
