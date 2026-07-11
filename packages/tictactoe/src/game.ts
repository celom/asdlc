export type Player = 'X' | 'O';
export type Cell = Player | null;

export interface GameState {
  board: readonly Cell[];
  turn: Player;
}

const LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];

export function newGame(): GameState {
  return { board: Array<Cell>(9).fill(null), turn: 'X' };
}

export function winner(board: readonly Cell[]): Player | null {
  for (const [a, b, c] of LINES) {
    if (board[a] && board[a] === board[b] && board[a] === board[c]) {
      return board[a];
    }
  }
  return null;
}

export function isDraw(board: readonly Cell[]): boolean {
  return winner(board) === null && board.every((cell) => cell !== null);
}

/** Play the current player's mark at `index`. Illegal moves (occupied cell,
 *  out-of-range index, or game already over) return the state unchanged. */
export function move(state: GameState, index: number): GameState {
  if (
    index < 0 ||
    index > 8 ||
    state.board[index] !== null ||
    winner(state.board) !== null
  ) {
    return state;
  }
  const board = state.board.slice();
  board[index] = state.turn;
  return { board, turn: state.turn === 'X' ? 'O' : 'X' };
}
