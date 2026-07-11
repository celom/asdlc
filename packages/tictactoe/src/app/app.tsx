import { useState } from 'react';
import styles from './app.module.css';
import { newGame, move, winner, isDraw } from '../game';

export function App() {
  const [game, setGame] = useState(newGame);

  const won = winner(game.board);
  const status = won
    ? `${won} wins`
    : isDraw(game.board)
      ? 'Draw'
      : `${game.turn} to move`;

  return (
    <main className={styles.game}>
      <h1>Tic-tac-toe</h1>
      <p role="status">{status}</p>
      <div className={styles.board}>
        {game.board.map((cell, i) => (
          <button
            key={i}
            className={styles.cell}
            aria-label={`cell ${i}`}
            onClick={() => setGame(move(game, i))}
          >
            {cell}
          </button>
        ))}
      </div>
      <button onClick={() => setGame(newGame())}>Restart</button>
    </main>
  );
}

export default App;
