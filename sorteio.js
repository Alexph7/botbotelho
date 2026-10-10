
import { randomInt } from "node:crypto";
import { db } from "./database.js";

export function escaparHTML(valor) {
  return String(valor)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function nomeUsuario(usuario) {
  return [
    usuario.first_name,
    usuario.last_name
  ].filter(Boolean).join(" ").trim() || "Participante";
}

export function registrarReacao(evento) {
  const sorteio = db.prepare(`
    SELECT * FROM sorteios
    WHERE grupo_id=?
      AND mensagem_id=?
      AND status='aberto'
  `).get(
    String(evento.chat.id),
    evento.message_id
  );

  if (!sorteio || !evento.user || evento.user.is_bot) {
    return;
  }

  const ativo = evento.new_reaction.length > 0;

  const usuario = evento.user;

  db.prepare(`
    INSERT INTO participantes (
      sorteio_id, usuario_id, nome,
      username, ativo, atualizado_em
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(sorteio_id, usuario_id)
    DO UPDATE SET
      nome=excluded.nome,
      username=excluded.username,
      ativo=excluded.ativo,
      atualizado_em=excluded.atualizado_em
  `).run(
    sorteio.id,
    String(usuario.id),
    nomeUsuario(usuario),
    usuario.username || null,
    ativo ? 1 : 0,
    Number(evento.date) * 1000
  );

  console.log(
    `[REAÇÃO] Sorteio ${sorteio.id}:`,
    nomeUsuario(usuario),
    ativo ? "ENTROU" : "SAIU"
  );
}

export function selecionarGanhadores(sorteio) {
  const participantes = db.prepare(`
    SELECT usuario_id, nome
    FROM participantes
    WHERE sorteio_id=? AND ativo=1
  `).all(sorteio.id);

  const premios = JSON.parse(sorteio.premios);

  if (premios.length !== sorteio.quantidade) {
    throw new Error("Quantidade de prêmios inconsistente");
  }

  if (participantes.length < sorteio.quantidade) {
    return null;
  }

  // Fisher-Yates parcial: escolha sem repetição.
  for (let i = 0; i < sorteio.quantidade; i++) {
    const j = randomInt(i, participantes.length);

    [participantes[i], participantes[j]] =
      [participantes[j], participantes[i]];
  }

  return participantes
    .slice(0, sorteio.quantidade)
    .map((p, indice) => ({
      posicao: indice + 1,
      usuario_id: p.usuario_id,
      nome: p.nome,
      premio: premios[indice]
    }));
}

export function formatarResultado(sorteio, vencedores) {
  const linhas = [
    "🏆 <b>RESULTADO DO SORTEIO</b>",
    "",
    escaparHTML(sorteio.mensagem),
    ""
  ];

  const medalhas = ["🥇", "🥈", "🥉"];

  for (const vencedor of vencedores) {
    const medalha = medalhas[vencedor.posicao - 1] || "🎁";

    const perfil =
      `<a href="tg://user?id=${vencedor.usuario_id}">` +
      escaparHTML(vencedor.nome) +
      "</a>";

    linhas.push(
      `${medalha} ${perfil} — ${escaparHTML(vencedor.premio)}`
    );
  }

  linhas.push("", "🎉 Parabéns aos ganhadores!");

  return linhas.join("\n");
}
