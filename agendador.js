
import { db } from "./database.js";
import {
  escaparHTML,
  selecionarGanhadores,
  formatarResultado
} from "./sorteio.js";

let executando = false;

function formatarAviso(sorteio) {
  const premios = JSON.parse(sorteio.premios);

  const lista = premios.map(
    (premio, i) => `${i + 1}. ${escaparHTML(premio)}`
  ).join("\n");

  const horario = new Date(sorteio.sortear_em)
    .toLocaleString("pt-BR", {
      timeZone: "America/Sao_Paulo"
    });

  return [
    "🎁 <b>SORTEIO ESPECIAL</b>",
    "",
    escaparHTML(sorteio.mensagem),
    "",
    "<b>PRÊMIOS:</b>",
    lista,
    "",
    "🎉 <b>PARA PARTICIPAR:</b>",
    "Reaja a esta mensagem com qualquer emoji para participar.",
    "",
    `⏰ Sorteio: ${horario}`,
    "",
    "Cada participante poderá ganhar apenas uma vez."
  ].join("\n");
}

async function publicarSorteio(sorteio, api) {
  // Evita enviar novamente enquanto processa.
  const alteracao = db.prepare(`
    UPDATE sorteios
    SET status='publicando'
    WHERE id=? AND status='agendado'
  `).run(sorteio.id);

  if (!alteracao.changes) return;

  try {
    const mensagem = await api("sendMessage", {
      chat_id: sorteio.grupo_id,
      text: formatarAviso(sorteio),
      parse_mode: "HTML"
    });

    db.prepare(`
      UPDATE sorteios
      SET status='aberto',
          grupo_id=?,
          mensagem_id=?
      WHERE id=?
    `).run(
      String(mensagem.chat.id),
      mensagem.message_id,
      sorteio.id
    );

    console.log(
      `[SORTEIO ${sorteio.id}] Inscrições abertas`
    );
  } catch (erro) {
    db.prepare(`
      UPDATE sorteios SET status='erro_publicacao'
      WHERE id=?
    `).run(sorteio.id);

    console.error("Erro ao publicar sorteio:", erro);
  }
}

async function encerrarSorteio(sorteio, api) {
  const alteracao = db.prepare(`
    UPDATE sorteios
    SET status='processando'
    WHERE id=? AND status='aberto'
  `).run(sorteio.id);

  if (!alteracao.changes) return;

  try {
    const vencedores = selecionarGanhadores(sorteio);

    if (!vencedores) {
      const quantidade = db.prepare(`
        SELECT COUNT(*) AS total
        FROM participantes
        WHERE sorteio_id=? AND ativo=1
      `).get(sorteio.id).total;

      const mensagem = [
        "⚠️ <b>SORTEIO ENCERRADO</b>",
        "",
        `Participantes: ${quantidade}`,
        `Ganhadores previstos: ${sorteio.quantidade}`,
        "",
        "Participantes insuficientes.",
        "Nenhum prêmio foi sorteado."
      ].join("\n");

      await api("sendMessage", {
        chat_id: sorteio.grupo_id,
        text: mensagem,
        parse_mode: "HTML",
        reply_parameters: {
          message_id: sorteio.mensagem_id
        }
      });

      db.prepare(`
        UPDATE sorteios
        SET status='insuficiente'
        WHERE id=?
      `).run(sorteio.id);

      return;
    }

    const salvar = db.transaction(() => {
      const inserir = db.prepare(`
        INSERT OR IGNORE INTO vencedores (
          sorteio_id, posicao, usuario_id, nome, premio
        ) VALUES (?, ?, ?, ?, ?)
      `);

      for (const vencedor of vencedores) {
        inserir.run(
          sorteio.id,
          vencedor.posicao,
          vencedor.usuario_id,
          vencedor.nome,
          vencedor.premio
        );
      }
    });

    salvar();

    await api("sendMessage", {
      chat_id: sorteio.grupo_id,
      text: formatarResultado(sorteio, vencedores),
      parse_mode: "HTML",
      reply_parameters: {
        message_id: sorteio.mensagem_id
      }
    });

    db.prepare(`
      UPDATE sorteios
      SET status='finalizado'
      WHERE id=?
    `).run(sorteio.id);

    console.log(
      `[SORTEIO ${sorteio.id}] Finalizado`
    );
  } catch (erro) {
    console.error(
      `[SORTEIO ${sorteio.id}] Falha:`,
      erro
    );

    db.prepare(`
      UPDATE sorteios
      SET status='erro_resultado'
      WHERE id=?
    `).run(sorteio.id);
  }
}

export async function verificarAgendamentos(api) {
  if (executando) return;

  executando = true;

  try {
    const agora = Date.now();

    const publicar = db.prepare(`
      SELECT * FROM sorteios
      WHERE status='agendado'
        AND publicar_em <= ?
      ORDER BY publicar_em
    `).all(agora);

    for (const sorteio of publicar) {
      await publicarSorteio(sorteio, api);
    }

    const encerrar = db.prepare(`
      SELECT * FROM sorteios
      WHERE status='aberto'
        AND sortear_em <= ?
      ORDER BY sortear_em
    `).all(Date.now());

    for (const sorteio of encerrar) {
      await encerrarSorteio(sorteio, api);
    }
  } finally {
    executando = false;
  }
}
