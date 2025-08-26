document.getElementById('startBtn').addEventListener('click', startNetworkAnalysis);
document.getElementById('startCaptureBtn').addEventListener('click', startPacketCapture);
document.getElementById('checkSecurityBtn').addEventListener('click', runSecurityScan);

function startNetworkAnalysis() {
    const url = document.getElementById('urlInput').value;
    if (!url) {
        alert('Please enter a URL');
        return;
    }

    // Display status message
    document.getElementById('statusMessage').innerText = `Analyzing ${url}...`;

    // Simulate network analysis (HTTP request, DNS lookup, etc.)
    fetchNetworkData(url);
}

function fetchNetworkData(url) {
    // Example of network analysis: fetch HTTP headers, status code, and DNS resolution
    fetch(`https://api.ipify.org?format=json`)
        .then(response => response.json())
        .then(data => {
            displayResults(data);
        })
        .catch(error => {
            document.getElementById('statusMessage').innerText = `Failed to fetch data: ${error.message}`;
        });
}

function displayResults(data) {
    const resultsContainer = document.getElementById('results');
    resultsContainer.innerHTML = `
        <p><strong>Public IP:</strong> ${data.ip}</p>
        <p><strong>Location:</strong> ${data.country}</p>
        <p><strong>Status:</strong> Connection successful</p>
    `;
    document.getElementById('statusMessage').innerText = `Analysis complete for ${data.ip}`;
}

function startPacketCapture() {
    document.getElementById('captureResults').innerHTML = "Capturing packets...";

    // Simulate packet capture and display
    setTimeout(() => {
        document.getElementById('captureResults').innerHTML = "Packet capture complete. (Simulated data)";
    }, 2000);
}

function runSecurityScan() {
    document.getElementById('securityResults').innerHTML = "Running security scan...";

    // Simulate security scan (e.g., SSL/TLS check)
    setTimeout(() => {
        document.getElementById('securityResults').innerHTML = `
            <p><strong>SSL/TLS Status:</strong> Secure (Valid Certificate)</p>
            <p><strong>Potential Threats:</strong> No vulnerabilities detected</p>
        `;
    }, 3000);
}

