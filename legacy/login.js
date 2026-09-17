document.getElementById('adminLoginForm').addEventListener('submit', (event) => {
    event.preventDefault();

    const username = document.getElementById('adminUsername').value;
    const password = document.getElementById('adminPassword').value;

    const adminUsername = 'admin';
    const adminPassword = 'adminpass'; // Use secure storage for credentials in production

    if (username === adminUsername && password === adminPassword) {
        localStorage.setItem('userRole', 'admin');
        window.location.href = 'index.html';
    } else {
        document.getElementById('loginMessage').innerText = 'Invalid admin credentials!';
    }
});
