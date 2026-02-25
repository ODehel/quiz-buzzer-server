const express = require('express');
const router = express.Router();

router.get('/', (req, res) => {
  res.json({ message: 'Buzzers routes - TODO' });
});

module.exports = router;