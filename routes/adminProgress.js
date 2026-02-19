const express = require('express');
const { verifyToken, requireAdmin } = require('../middleware/auth');
const { getUsers, getUserProgress } = require('../controllers/adminProgressController');

const router = express.Router();
router.use(verifyToken);
router.use(requireAdmin);

router.get('/users', getUsers);
router.get('/user-progress/:userId', getUserProgress);

module.exports = router;
