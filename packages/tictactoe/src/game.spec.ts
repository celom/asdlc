import { newGame, move, winner, isDraw, type Cell } from './game';

function play(indices: number[]) {
  return indices.reduce(move, newGame());
}

describe('newGame', () => {
  it('starts with an empty board and X to move', () => {
    const state = newGame();
    expect(state.board).toEqual(Array(9).fill(null));
    expect(state.turn).toBe('X');
  });
});

describe('move', () => {
  it('places the current player mark and alternates turns, X first', () => {
    let state = move(newGame(), 4);
    expect(state.board[4]).toBe('X');
    expect(state.turn).toBe('O');

    state = move(state, 0);
    expect(state.board[0]).toBe('O');
    expect(state.turn).toBe('X');
  });

  it('rejects a move on an occupied cell, leaving state unchanged', () => {
    const state = move(newGame(), 4);
    expect(move(state, 4)).toBe(state);
  });

  it('rejects out-of-range indices', () => {
    const state = newGame();
    expect(move(state, -1)).toBe(state);
    expect(move(state, 9)).toBe(state);
  });

  it('rejects further moves after a win', () => {
    // X: 0, 1, 2 (top row) — O: 3, 4
    const won = play([0, 3, 1, 4, 2]);
    expect(winner(won.board)).toBe('X');
    expect(move(won, 5)).toBe(won);
  });
});

describe('winner', () => {
  const lines = [
    [0, 1, 2],
    [3, 4, 5],
    [6, 7, 8],
    [0, 3, 6],
    [1, 4, 7],
    [2, 5, 8],
    [0, 4, 8],
    [2, 4, 6],
  ];

  it.each(lines)('detects a win on line %d,%d,%d', (a, b, c) => {
    const board: Cell[] = Array(9).fill(null);
    for (const i of [a, b, c]) board[i] = 'O';
    expect(winner(board)).toBe('O');
  });

  it('returns null when no line is complete', () => {
    expect(winner(newGame().board)).toBeNull();
    expect(winner(play([0, 4, 8]).board)).toBeNull();
  });
});

describe('isDraw', () => {
  it('is a draw when the board is full with no winner', () => {
    // X O X / X O O / O X X — no three in a line
    const drawn = play([0, 1, 2, 4, 3, 5, 7, 6, 8]);
    expect(winner(drawn.board)).toBeNull();
    expect(drawn.board.every((cell) => cell !== null)).toBe(true);
    expect(isDraw(drawn.board)).toBe(true);
  });

  it('is not a draw while the game is in progress or won', () => {
    expect(isDraw(newGame().board)).toBe(false);
    expect(isDraw(play([0, 3, 1, 4, 2]).board)).toBe(false);
  });
});
