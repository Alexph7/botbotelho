
import Database from "better-sqlite3";

export const db = new Database("sorteios.db");

db.pragma("journal_mode = WAL");
db.pragma("busy_timeout = 5000");

db.exec(`
CREATE TABLE IF NOT EXISTS configuracoes (
  chave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cadastros (
  usuario_id TEXT PRIMARY KEY,
  etapa TEXT NOT NULL,
  dados TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sorteios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mensagem TEXT NOT NULL,
  quantidade INTEGER NOT NULL,
  premios TEXT NOT NULL,
  publicar_em INTEGER NOT NULL,
  sortear_em INTEGER NOT NULL,
  grupo_id TEXT NOT NULL,
  mensagem_id INTEGER,
  status TEXT NOT NULL DEFAULT 'agendado',
  criado_em INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participantes (
  sorteio_id INTEGER NOT NULL,
  usuario_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  username TEXT,
  ativo INTEGER NOT NULL DEFAULT 1,
  atualizado_em INTEGER NOT NULL,
  PRIMARY KEY (sorteio_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS vencedores (
  sorteio_id INTEGER NOT NULL,
  posicao INTEGER NOT NULL,
  usuario_id TEXT NOT NULL,
  nome TEXT NOT NULL,
  premio TEXT NOT NULL,
  PRIMARY KEY (sorteio_id, posicao),
  UNIQUE (sorteio_id, usuario_id)
);
`);

export function configurar(chave, valor) {
  db.prepare(`
    INSERT INTO configuracoes(chave, valor)
    VALUES (?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor
  `).run(chave, String(valor));
}

export function obterConfiguracao(chave, padrao = null) {
  return db.prepare(
    "SELECT valor FROM configuracoes WHERE chave=?"
  ).get(chave)?.valor ?? padrao;
}

export function salvarCadastro(usuarioId, etapa, dados) {
  db.prepare(`
    INSERT INTO cadastros(usuario_id, etapa, dados)
    VALUES (?, ?, ?)
    ON CONFLICT(usuario_id) DO UPDATE SET
      etapa=excluded.etapa,
      dados=excluded.dados
  `).run(String(usuarioId), etapa, JSON.stringify(dados));
}

export function obterCadastro(usuarioId) {
  const cadastro = db.prepare(
    "SELECT * FROM cadastros WHERE usuario_id=?"
  ).get(String(usuarioId));

  if (!cadastro) return null;

  return {
    etapa: cadastro.etapa,
    dados: JSON.parse(cadastro.dados)
  };
}

export function excluirCadastro(usuarioId) {
  db.prepare(
    "DELETE FROM cadastros WHERE usuario_id=?"
  ).run(String(usuarioId));
}
