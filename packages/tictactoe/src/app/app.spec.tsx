import { render, screen, fireEvent } from '@testing-library/react';

import App from './app';

function cell(index: number) {
  return screen.getByRole('button', { name: `cell ${index}` });
}

function status() {
  return screen.getByRole('status').textContent;
}

describe('App', () => {
  it('renders the board with X to move', () => {
    render(<App />);
    expect(status()).toBe('X to move');
    expect(screen.getAllByRole('button', { name: /cell \d/ })).toHaveLength(9);
  });

  it('plays alternating moves and announces a win', () => {
    render(<App />);
    // X: 0, 1, 2 (top row) — O: 3, 4
    for (const i of [0, 3, 1, 4]) fireEvent.click(cell(i));
    expect(status()).toBe('X to move');
    fireEvent.click(cell(2));
    expect(status()).toBe('X wins');
  });

  it('restart clears the board', () => {
    render(<App />);
    fireEvent.click(cell(0));
    expect(cell(0).textContent).toBe('X');
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    expect(cell(0).textContent).toBe('');
    expect(status()).toBe('X to move');
  });
});
