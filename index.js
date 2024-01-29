const express = require('express')
const { createServer } = require('node:http')
const { join } = require('node:path')
const { Server } = require('socket.io')
const sqlite3 = require('sqlite3')
const { open } = require('sqlite')
const bodyParser = require('body-parser');
const multer = require('multer');
const upload = multer();

const app = express()
const server = createServer(app)
app.use(bodyParser.urlencoded({ extended: true }))
app.use(express.static('public'));

usersConnected = []
//function permettant de supprimer de la liste un nom
function supprimerNom(nom, liste) {
    let index = liste.indexOf(nom);
    if (index !== -1) {
        liste.splice(index, 1);
    }
}

async function main(){
    //permet d'acceder à la base de donné
    const db = await open({
        filename: 'chat.db',
        driver: sqlite3.Database
    })
    //permet de créer la base de donné si elle n'exitste pas
    await db.exec(`
        CREATE TABLE IF NOT EXISTS user (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pseudo TEXT NOT NULL,
            image TEXT
        );
        
        CREATE TABLE IF NOT EXISTS salon (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            nom TEXT NOT NULL,
            description TEXT
        );

        CREATE TABLE IF NOT EXISTS message (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            salon_id INTEGER,
            content TEXT,
            FOREIGN KEY (user_id) REFERENCES user(id),
            FOREIGN KEY (salon_id) REFERENCES salon(id)
        );
    `)

    //créer le serveur 
    const io = new Server(server, {
        connectionStateRecovery: {
            maxDisconnectionDuration: 2 * 60 * 1000,
        }
    })

    
    //Middleware force l'utilisateur à avoir un nom d'utilisateur en passant par la route / 
    const validateUrlCredential = async (req, res, next) => {
        const existingUser = await db.get('SELECT id FROM user WHERE pseudo = ?', req.params.username)
        const salon = await db.get('SELECT id FROM salon WHERE id = ?', req.params.id)
        if (!salon || !existingUser) {
            return res.status(400).send('Le nom d utilisateur / salon existe pas');
        }
        next()

    };

    //routes utilisé par l'appplication
    app.get('/', async (req, res) => {
        try {
            const salons = await db.all('SELECT id, nom FROM salon')
            res.render(join(__dirname, 'vues/params.ejs'), { salons })
        } catch (error) {
            console.error(error)
            res.status(500).send('Internal Server Error')
        }
    })
    
    app.get('/salon/:id/:username', validateUrlCredential, async (req, res) => {
        const salonId = req.params.id
        const username = req.params.username
        res.render(join(__dirname, 'vues/chat.ejs'), { salonId , username})
    })

    app.post('/createUser', upload.none(), async (req, res) => {
        try {
            const username = req.body.username
            const selectedSalonName = req.body.channel

            const existingUser = await db.get('SELECT id FROM user WHERE pseudo = ?', username)
            const salon = await db.get('SELECT id FROM salon WHERE nom = ?', selectedSalonName)

            if (!existingUser) {
                await db.run('INSERT INTO user (pseudo) VALUES (?)', username)
            }
            if (!salon) {
                res.status(404).send('Salon not found');
                return;
            }
            res.redirect(`/salon/${salon.id}/${username}`)
        } catch (error) {
            res.status(500).send('Internal Server Error')
        }
    })

    app.get('/newChannel',  (req, res) => {
        res.render(join(__dirname, 'vues/createChannel.ejs'))
    })

    app.post('/newChannel', upload.none(), async (req, res) => {

        const nomSalon = req.body.nomSalon
        const descriptionSalon = req.body.descriptionSalon

        try {
            const existingSalon = await db.get('SELECT id FROM salon WHERE nom = ?', nomSalon)

            if (!existingSalon) {
                await db.run('INSERT INTO salon (nom, description) VALUES (?, ?)', nomSalon, descriptionSalon)
            }
            req.body = {}
            res.redirect('/')
        } catch (error) {
            console.log(error)
            res.status(500).send('Internal Server Error')
        }
    })
    
    //WEBSOCKET utilisé par l'application
    io.on('connection', async (socket) => {

        const salonId = socket.handshake.auth.salonId
        const username = socket.handshake.auth.username
        socket.join(salonId)

        if (!(usersConnected.includes(username))){
            await usersConnected.push(username);
        }
        socket.broadcast.to(salonId).emit('userConnect', username);
        io.emit('updateUserConnectedList', usersConnected);
        // si le message de chat est reçu => émet le message à tout le monde
        socket.on('chat message', async (msg, salonId, username) => {
            let result
            const existingUser = await db.get('SELECT id FROM user WHERE pseudo = ?', username)
            try {
                result = await db.run('INSERT INTO message (user_id, salon_id, content) VALUES (?, ?, ?)', existingUser.id, salonId, msg)
            } catch (e) {
                return e
            }
            io.to(salonId).emit('chat message', msg, result.lastID, username)
        });

        if (!socket.recovered) {
            // si le rétablissement de l'état de la connexion n'a pas réussi
            try {
            await db.each('SELECT m.id, m.user_id, m.content, u.pseudo FROM message m JOIN user u ON m.user_id = u.id WHERE m.id > ? AND m.salon_id = ?',
                [socket.handshake.auth.serverOffset || 0, salonId],
                async (_err, row) => {
                    socket.emit('chat message', row.content, row.id, row.pseudo);
                }
            )
            } catch (e) {

            }
        }

        // en cas de réception d'un événement de déconnexion
        socket.on('disconnect', () => {
            supprimerNom(username, usersConnected)
            socket.broadcast.to(salonId).emit('userDisconnect', username)
            io.emit('updateUserConnectedList', usersConnected);
        })

        //permet de gérer le "nom is typing"
        let typingTimeout;

        socket.on('typing', (salonId, username) => {
            socket.broadcast.to(salonId).emit('user typing', salonId, username)
            clearTimeout(typingTimeout)
        });

        socket.on('not typing', (salonId) => {
            typingTimeout = setTimeout(() => {
                socket.broadcast.to(salonId).emit('user not typing')
            }, 2000)
        });
    })

    //écrit dans la console ou trouver la page web
    server.listen(3000, () => {
        console.log('server running at http://localhost:3000')
    })
}

main()