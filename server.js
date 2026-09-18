require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const postgres = require('postgres');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ⚙️ Conexão com o Supabase (PostgreSQL via Pooler)
const connectionString = process.env.DATABASE_URL;
const sql = postgres(connectionString, { 
    ssl: 'require',
    family: 4
});

// Testar conexão ao iniciar
async function testarConexao() {
    try {
        const result = await sql`SELECT NOW()`;
        console.log('Conectado ao Supabase (PostgreSQL) com sucesso!', result[0].now);
    } catch (err) {
        console.error('Erro ao conectar ao Supabase:', err.message);
    }
}
testarConexao();

// Funções de apoio para cadastro e login
async function cadastrarUsuario(req, res) {
  const { usuario, senha } = req.body;
  if (!usuario || !senha) {
    return res.status(400).json({ mensagem: 'Preencha usuário e senha!', erro: 'Dados incompletos' });
  }

  try {
    const existente = await sql`SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER(${usuario})`;
    if (existente.length > 0) {
      return res.status(400).json({ mensagem: 'Usuário já cadastrado!', erro: 'Usuário existente' });
    }

    await sql`INSERT INTO usuarios (usuario, senha) VALUES (${usuario}, ${senha})`;
    return res.status(201).json({ mensagem: 'Cadastro realizado com sucesso!' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ mensagem: 'Erro interno no servidor.' });
  }
}

async function autenticarUsuario(req, res) {
  const { usuario, senha } = req.body;
  try {
    const users = await sql`SELECT * FROM usuarios WHERE LOWER(usuario) = LOWER(${usuario}) AND senha = ${senha}`;
    
    if (users.length === 0) {
      return res.status(401).json({ mensagem: 'Usuário ou senha incorretos!', erro: 'Credenciais inválidas' });
    }

    return res.json({ mensagem: 'Login bem-sucedido!', usuario: users[0].usuario });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ mensagem: 'Erro interno no servidor.' });
  }
}

// Rotas de Autenticação
app.post('/api/cadastro', cadastrarUsuario);
app.post('/api/register', cadastrarUsuario);
app.post('/api/login', autenticarUsuario);

// Rotas API de Produtos
app.get('/api/produtos', async (req, res) => {
  try {
    const produtos = await sql`SELECT * FROM produtos`;
    res.json(produtos);
  } catch (err) {
    res.status(500).json({ mensagem: 'Erro ao buscar produtos' });
  }
});

app.post('/api/produtos', async (req, res) => {
  const { nome, categoria, preco, foto, promocao, obs } = req.body;
  try {
    const [novoProduto] = await sql`
      INSERT INTO produtos (nome, categoria, preco, foto, promocao, obs) 
      VALUES (${nome}, ${categoria}, ${parseFloat(preco)}, ${foto}, ${Boolean(promocao)}, ${obs}) 
      RETURNING *
    `;
    // Busca todos atualizados para manter o emit idêntico ao seu app
    const todosProdutos = await sql`SELECT * FROM produtos`;
    io.emit('produtos_atualizados', todosProdutos);
    res.status(201).json(novoProduto);
  } catch (err) {
    console.error(err);
    res.status(500).json({ mensagem: 'Erro ao salvar produto' });
  }
});

// Rota de busca de pedidos
app.get('/api/pedidos', async (req, res) => {
  const { usuario } = req.query;
  try {
    let pedidos;
    if (usuario) {
      pedidos = await sql`SELECT * FROM pedidos WHERE LOWER(usuario) = LOWER(${usuario})`;
    } else {
      pedidos = await sql`SELECT * FROM pedidos`;
    }
    res.json(pedidos);
  } catch (err) {
    res.status(500).json({ mensagem: 'Erro ao buscar pedidos' });
  }
});

app.get('/api/avaliacoes', async (req, res) => {
  try {
    const avaliacoes = await sql`SELECT * FROM avaliacoes`;
    res.json(avaliacoes);
  } catch (err) {
    res.json([]);
  }
});

// Socket.io integrado ao banco
io.on('connection', (socket) => {
  socket.on('novo_pedido', async (dados) => {
    try {
      const formaPagamento = dados.pagamento || dados.formaPagamento || 'Não especificado';
      const valorTroco = dados.troco || null;

      const [pedido] = await sql`
        INSERT INTO pedidos (cliente, usuario, endereco, itens, total, pagamento, troco, status, data) 
        VALUES (${dados.cliente}, ${dados.usuario || dados.cliente}, ${dados.endereco}, ${sql.json(dados.itens)}, ${dados.total}, ${formaPagamento}, ${valorTroco}, 'Aguardando Aprovação', ${new Date().toLocaleDateString('pt-BR')}) 
        RETURNING *
      `;
      io.emit('pedido_recebido_comercio', pedido);
      io.emit('status_atualizado', pedido);
    } catch (err) {
      console.error('Erro ao salvar pedido:', err);
    }
  });

  socket.on('aceitar_pedido', async (pedidoId) => {
    try {
      const [p] = await sql`UPDATE pedidos SET status = 'Em Preparo / Aceito' WHERE id = ${pedidoId} RETURNING *`;
      if (p) io.emit('status_atualizado', p);
    } catch (err) { console.error(err); }
  });

  socket.on('despachar_motoboy', async (pedidoId) => {
    try {
      const [p] = await sql`UPDATE pedidos SET status = 'Aguardando Aceite do Motoboy' WHERE id = ${pedidoId} RETURNING *`;
      if (p) {
        io.emit('pedido_disponivel_motoboy', p);
        io.emit('status_atualizado', p);
      }
    } catch (err) { console.error(err); }
  });

  socket.on('motoboy_aceitou', async (pedidoId) => {
    try {
      const [p] = await sql`UPDATE pedidos SET status = 'Motoboy Aceitou (Indo ao Comércio)' WHERE id = ${pedidoId} RETURNING *`;
      if (p) io.emit('status_atualizado', p);
    } catch (err) { console.error(err); }
  });

  socket.on('motoboy_a_caminho', async (pedidoId) => {
    try {
      const [p] = await sql`UPDATE pedidos SET status = 'Saiu para entregar' WHERE id = ${pedidoId} RETURNING *`;
      if (p) io.emit('status_atualizado', p);
    } catch (err) { console.error(err); }
  });

  socket.on('confirmar_entrega', async (pedidoId) => {
    try {
      const [p] = await sql`UPDATE pedidos SET status = 'Entregue' WHERE id = ${pedidoId} RETURNING *`;
      if (p) io.emit('status_atualizado', p);
    } catch (err) { console.error(err); }
  });

  socket.on('enviar_avaliacao', async (dados) => {
    try {
      await sql`INSERT INTO avaliacoes (dados) VALUES (${sql.json(dados)})`;
      io.emit('nova_avaliacao', dados);
    } catch (err) { console.error(err); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor rodando em http://localhost:${PORT}`));