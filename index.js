
import "dotenv/config";
import { DateTime } from "luxon";

import {
    db,
    configurar,
    obterConfiguracao,
    salvarCadastro,
    obterCadastro,
    excluirCadastro
} from "./database.js";

import { registrarReacao } from "./sorteio.js";
import { verificarAgendamentos } from "./agendador.js";

const TOKEN = process.env.BOT_TOKEN;
const GRUPO_ID = process.env.GRUPO_ID || "@cupom7";
const ZONA = "America/Sao_Paulo";

if (!TOKEN) {
    throw new Error("Configure BOT_TOKEN no .env");
}

const API_URL = `https://api.telegram.org/bot${TOKEN}/`;

async function api(metodo, parametros = {}) {
    const resposta = await fetch(API_URL + metodo, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(parametros),
        signal: AbortSignal.timeout(40000)
    });

    const resultado = await resposta.json();

    if (!resultado.ok) {
        throw new Error(
            `${metodo}: ${resultado.description}`
        );
    }

    return resultado.result;
}

async function responder(chatId, texto, botoes = null) {
    const parametros = {
        chat_id: chatId,
        text: texto
    };

    if (botoes) {
        parametros.reply_markup = {
            inline_keyboard: botoes
        };
    }

    return api("sendMessage", parametros);
}

function interpretarData(texto) {
    const data = DateTime.fromFormat(
        texto.trim(),
        "dd/MM/yyyy HH:mm",
        {
            zone: ZONA,
            locale: "pt-BR"
        }
    );

    return data.isValid ? data.toMillis() : null;
}

function proximaEtapa(chatId, usuarioId, etapa, dados, texto) {
    salvarCadastro(usuarioId, etapa, dados);
    return responder(chatId, texto);
}

async function receberTexto(mensagem) {
    if (mensagem.chat.type !== "private") return;

    const usuarioId = String(mensagem.from.id);
    const chatId = mensagem.chat.id;
    const texto = (mensagem.text || "").trim();


    if (texto === "/cancelar") {
        excluirCadastro(usuarioId);
        await responder(chatId, "Cadastro cancelado.");
        return;
    }

    if (texto === "/sorte") {
        await proximaEtapa(
            chatId,
            usuarioId,
            "mensagem",
            {},
            "🎁 NOVO SORTEIO\n\nQual será a mensagem do sorteio?"
        );
        return;
    }

    if (texto === "/status") {
        const sorteios = db.prepare(`
      SELECT id, status, quantidade
      FROM sorteios
      ORDER BY id DESC
      LIMIT 10
    `).all();

        const linhas = sorteios.map(
            s => `#${s.id} — ${s.status} — ${s.quantidade} ganhador(es)`
        );

        await responder(
            chatId,
            linhas.join("\n") || "Nenhum sorteio cadastrado."
        );
        return;
    }

    const cadastro = obterCadastro(usuarioId);

    if (!cadastro) return;

    const { etapa, dados } = cadastro;

    if (etapa === "mensagem") {
        if (!texto || texto.length > 2500) {
            await responder(
                chatId,
                "Digite uma mensagem com até 2500 caracteres."
            );
            return;
        }

        dados.mensagem = texto;

        await proximaEtapa(
            chatId,
            usuarioId,
            "quantidade",
            dados,
            "Quantos ganhadores teremos? (1 a 50)"
        );
        return;
    }

    if (etapa === "quantidade") {
        const quantidade = Number(texto);

        if (
            !/^\d+$/.test(texto) ||
            quantidade < 1 ||
            quantidade > 50
        ) {
            await responder(
                chatId,
                "Informe um número inteiro de 1 a 50."
            );
            return;
        }

        dados.quantidade = quantidade;
        dados.premios = [];

        await proximaEtapa(
            chatId,
            usuarioId,
            "premio",
            dados,
            "🎁 Cadastre o primeiro prêmio:"
        );
        return;
    }

    if (etapa === "premio") {
        if (!texto || texto.length > 200) {
            await responder(
                chatId,
                "O prêmio deve ter entre 1 e 200 caracteres."
            );
            return;
        }

        dados.premios.push(texto);

        // Chegou ao total de prêmios necessário.
        if (dados.premios.length >= dados.quantidade) {
            await proximaEtapa(
                chatId,
                usuarioId,
                "publicacao",
                dados,
                "✅ Todos os prêmios cadastrados!\n\n" +
                "Quando publicar o aviso?\n\n" +
                "Formato: DD/MM/AAAA HH:MM\n" +
                "Exemplo: 15/10/2026 18:00"
            );
            return;
        }

        salvarCadastro(usuarioId, "confirmar_premio", dados);

        await responder(
            chatId,
            `✅ Prêmio ${dados.premios.length} cadastrado.\n\n` +
            "Deseja cadastrar outro prêmio?",
            [[
                {
                    text: "✅ Sim",
                    callback_data: "premio_sim"
                },
                {
                    text: "❌ Não",
                    callback_data: "premio_nao"
                }
            ]]
        );
        return;
    }

    if (etapa === "confirmar_premio") {
        await responder(
            chatId,
            "Utilize os botões Sim ou Não."
        );
        return;
    }

    if (etapa === "publicacao") {
        const data = interpretarData(texto);

        if (!data || data <= Date.now() + 60000) {
            await responder(
                chatId,
                "Data inválida. Informe uma data futura, " +
                "com pelo menos 1 minuto de antecedência.\n" +
                "Exemplo: 15/10/2026 18:00"
            );
            return;
        }

        dados.publicar_em = data;

        await proximaEtapa(
            chatId,
            usuarioId,
            "encerramento",
            dados,
            "⏰ Que dia e hora o sorteio será realizado?\n\n" +
            "Formato: DD/MM/AAAA HH:MM\n" +
            "Exemplo: 15/10/2026 21:00"
        );
        return;
    }

    if (etapa === "encerramento") {
        const data = interpretarData(texto);

        if (!data || data <= dados.publicar_em) {
            await responder(
                chatId,
                "O encerramento precisa ocorrer depois " +
                "da publicação. Informe a data novamente."
            );
            return;
        }

        dados.sortear_em = data;

        db.prepare(`
      INSERT INTO sorteios (
        mensagem, quantidade, premios,
        publicar_em, sortear_em, grupo_id,
        status, criado_em
      )
      VALUES (?, ?, ?, ?, ?, ?, 'agendado', ?)
    `).run(
            dados.mensagem,
            dados.quantidade,
            JSON.stringify(dados.premios),
            dados.publicar_em,
            dados.sortear_em,
            GRUPO_ID,
            Date.now()
        );

        excluirCadastro(usuarioId);

        const publicado = DateTime
            .fromMillis(dados.publicar_em, { zone: ZONA })
            .toFormat("dd/MM/yyyy HH:mm");

        const sorteado = DateTime
            .fromMillis(dados.sortear_em, { zone: ZONA })
            .toFormat("dd/MM/yyyy HH:mm");

        await responder(
            chatId,
            "✅ SORTEIO AGENDADO!\n\n" +
            `👥 Ganhadores: ${dados.quantidade}\n` +
            `🎁 Prêmios: ${dados.premios.length}\n` +
            `📢 Publicação: ${publicado}\n` +
            `🏆 Sorteio: ${sorteado}\n\n` +
            "Grupo: @cupom7"
        );
    }
}

async function receberBotao(callback) {
    const usuarioId = String(callback.from.id);

    const cadastro = obterCadastro(usuarioId);

    if (
        !cadastro ||
        cadastro.etapa !== "confirmar_premio"
    ) {
        await api("answerCallbackQuery", {
            callback_query_id: callback.id,
            text: "Este cadastro não está mais ativo."
        });
        return;
    }

    const chatId = callback.message.chat.id;
    const dados = cadastro.dados;

    await api("answerCallbackQuery", {
        callback_query_id: callback.id
    });

    await api("editMessageReplyMarkup", {
        chat_id: chatId,
        message_id: callback.message.message_id,
        reply_markup: { inline_keyboard: [] }
    });

    if (callback.data === "premio_sim") {
        await proximaEtapa(
            chatId,
            usuarioId,
            "premio",
            dados,
            `🎁 Cadastre o prêmio ${dados.premios.length + 1}:`
        );
        return;
    }

    if (callback.data === "premio_nao") {
        await responder(
            chatId,
            `Você cadastrou ${dados.premios.length} prêmio(s), ` +
            `mas informou ${dados.quantidade} ganhadores.\n\n` +
            "Precisamos de um prêmio por ganhador. " +
            "Cadastre os restantes ou use /cancelar."
        );

        await proximaEtapa(
            chatId,
            usuarioId,
            "premio",
            dados,
            `Cadastre o prêmio ${dados.premios.length + 1}:`
        );
    }
}

async function tratarAtualizacao(update) {
    if (update.message) {
        await receberTexto(update.message);
    }

    if (update.callback_query) {
        await receberBotao(update.callback_query);
    }

    if (update.message_reaction) {
        registrarReacao(update.message_reaction);
    }
}

async function iniciar() {
    const bot = await api("getMe");

    console.log(`BOT ATIVO: @${bot.username}`);

    // O projeto utiliza polling, não webhook.
    const webhook = await api("getWebhookInfo");

    if (webhook.url) {
        throw new Error(
            "Existe um webhook configurado para este token. " +
            "Desative-o antes de utilizar polling."
        );
    }

    let offset = Number(
        obterConfiguracao("update_offset", "0")
    );

    // Agendador verifica a cada segundo.
    setInterval(() => {
        verificarAgendamentos(api).catch(console.error);
    }, 1000);

    await verificarAgendamentos(api);

    while (true) {
        try {
            const atualizacoes = await api("getUpdates", {
                offset,
                timeout: 25,
                limit: 100,
                allowed_updates: [
                    "message",
                    "callback_query",
                    "message_reaction"
                ]
            });

            for (const update of atualizacoes) {
                try {
                    await tratarAtualizacao(update);
                } catch (erro) {
                    console.error(
                        "Erro ao processar atualização:",
                        update.update_id,
                        erro
                    );

                    // Não confirma um evento que falhou.
                    throw erro;
                }

                offset = update.update_id + 1;
                configurar("update_offset", offset);
            }
        } catch (erro) {
            console.error("Erro no polling:", erro.message);

            await new Promise(
                resolve => setTimeout(resolve, 3000)
            );
        }
    }
}

iniciar().catch(erro => {
    console.error("Erro fatal:", erro);
    process.exit(1);
});
