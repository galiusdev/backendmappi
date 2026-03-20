const express = require('express');
const cors    = require('cors');
require('dotenv').config();

const paradasRoutes = require('./routes/paradas');
const rutasRoutes   = require('./routes/rutas');
const rutaRoutes    = require('./routes/ruta');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/paradas', paradasRoutes);
app.use('/api/rutas',   rutasRoutes);
app.use('/api/ruta',    rutaRoutes);

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', mensaje: 'Backend transporte AMSS funcionando' });
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});