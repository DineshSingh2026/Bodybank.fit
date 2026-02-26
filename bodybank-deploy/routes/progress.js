const express = require('express');
const { verifyToken } = require('../middleware/auth');
const { postProgress, getProgress } = require('../controllers/progressController');

const router = express.Router();
router.use(verifyToken);

router.post('/', postProgress);
router.get('/', getProgress);

module.exports = router;
