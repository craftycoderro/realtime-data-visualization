const ctx = document.getElementById('liveChart').getContext('2d');
const labels = [];
const dataPoints = [];

const liveChart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Live Value', data: dataPoints, borderWidth: 2, tension: 0.3 }] },
    options: { responsive: true, scales: { y: { beginAtZero: false } } }
});

const socket = io("http://localhost:3000");
let selectedDataset = 'bitcoin';
let isFiltering = false;

socket.on("newData", (data) => {
    const now = new Date(data.timestamp).toLocaleTimeString();
    const value = data[selectedDataset];

    if (labels.length > 15) {
        labels.shift();
        dataPoints.shift();
    }

    labels.push(now);
    dataPoints.push(value);
    liveChart.update();

    updateHistoryBuffer({ timestamp: data.timestamp, value });

    if (!isFiltering) {
        updateDatasetTable(data);
    }

    document.getElementById('currentValue').innerText = `${selectedDataset.toUpperCase()}: ${value.toFixed(2)} USD`;
});

const hctx = document.getElementById('historyChart').getContext('2d');
let historyLabels = [];
let historyPoints = [];

const historyChart = new Chart(hctx, {
    type: 'line',
    data: {
        labels: historyLabels,
        datasets: [{
            label: 'History Data',
            data: historyPoints,
            borderColor: 'blue',
            borderWidth: 2,
            tension: 0.3
        }]
    },
    options: {
        responsive: true,
        scales: {
            y: {},
            x: {
                ticks: {
                    autoSkip: true,
                    maxTicksLimit: 10
                }
            }
        },
        plugins: {
            zoom: {
                pan: {
                    enabled: true,
                    mode: 'x'
                },
                zoom: {
                    wheel: {
                        enabled: true
                    },
                    pinch: {
                        enabled: true
                    },
                    mode: 'x'
                }
            }
        }
    }
});

function updateHistoryBuffer(data) {
    const time = new Date(data.timestamp).toLocaleTimeString();

    if (historyLabels.length > 200) {
        historyLabels.shift();
        historyPoints.shift();
    }

    historyLabels.push(time);
    historyPoints.push(data.value);
    historyChart.update();
}

let isLoadingHistory = false;

async function loadHistory(filter) {
    if (isLoadingHistory) return;
    isLoadingHistory = true;

    // document.getElementById('historyLoading').style.display = 'flex';

    try {
        let url = `http://localhost:3000/api/history?filter=${filter}`;
        const res = await fetch(url);
        const docs = await res.json();

        historyLabels = docs.map(d => new Date(d.timestamp).toLocaleTimeString());
        historyPoints = docs.map(d => d[selectedDataset]);

        historyChart.data.labels = historyLabels;
        historyChart.data.datasets[0].data = historyPoints;
        historyChart.update();

        const stats = calculateStatistics(historyPoints);
        document.getElementById('statAvg').innerText = stats.avg;
        document.getElementById('statMin').innerText = stats.min;
        document.getElementById('statMax').innerText = stats.max;
    } catch (err) {
        console.error('Failed to load history:', err);
    } finally {
    //    document.getElementById('historyLoading').style.display = 'none';
        isLoadingHistory = false;
    }
}

function setChartType(type) {
    liveChart.config.type = type;
    liveChart.update();
    historyChart.config.type = type;
    historyChart.update();
}

function switchDataset(type) {
    selectedDataset = type;
    labels.length = 0;
    dataPoints.length = 0;
    liveChart.update();
    loadHistory(document.getElementById('timeRangeSelector').value);
}

function calculateStatistics(dataArray) {
    if (dataArray.length === 0) return { avg: '-', min: '-', max: '-' };
    const sum = dataArray.reduce((a, b) => a + b, 0);
    const avg = (sum / dataArray.length).toFixed(2);
    const min = Math.min(...dataArray).toFixed(2);
    const max = Math.max(...dataArray).toFixed(2);
    return { avg, min, max };
}

function updateDatasetTable(data) {
    const tableBody = document.getElementById('datasetTable').querySelector('tbody');
    const row = document.createElement('tr');
    const time = new Date(data.timestamp).toLocaleString();

    row.innerHTML = `
        <td>${time}</td>
        <td>${data.bitcoin?.toFixed(2) || '-'}</td>
        <td>${data.ethereum?.toFixed(2) || '-'}</td>
        <td>${data.bnb?.toFixed(2) || '-'}</td>
        <td>${data.xrp?.toFixed(2) || '-'}</td>
        <td>${data.sol?.toFixed(2) || '-'}</td>
    `;

    if (tableBody.rows.length >= 20) {
        tableBody.deleteRow(0);
    }

    tableBody.appendChild(row);
}

function applyNLPQuery() {
    const query = document.getElementById('nlpQueryInput').value.trim();

    if (!query) {
        isFiltering = false;
        document.getElementById('datasetTable').querySelector('tbody').innerHTML = '';
        return loadHistory('1h');
    }

    isFiltering = true;

    fetch(`http://localhost:3000/api/filter?query=${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
            const tableBody = document.getElementById('datasetTable').querySelector('tbody');
            tableBody.innerHTML = '';

            data.forEach(d => {
                const row = document.createElement('tr');
                const time = new Date(d.timestamp).toLocaleString();
                row.innerHTML = `
                    <td>${time}</td>
                    <td>${d.bitcoin?.toFixed(2) || '-'}</td>
                    <td>${d.ethereum?.toFixed(2) || '-'}</td>
                    <td>${d.bnb?.toFixed(2) || '-'}</td>
                    <td>${d.xrp?.toFixed(2) || '-'}</td>
                    <td>${d.sol?.toFixed(2) || '-'}</td>
                `;
                tableBody.appendChild(row);
            });
        });
}

window.addEventListener('DOMContentLoaded', () => {
    selectedDataset = document.getElementById('datasetDropdown').value;
    document.getElementById('timeRangeSelector').value = '1h';
    loadHistory('1h');
});

function loadCustomHistory() {
    const customMinutes = document.getElementById('customMinutes').value.trim();

    if (!customMinutes || isNaN(customMinutes) || customMinutes <= 0) {
        alert('Please enter a valid number of minutes.');
        return;
    }

    loadHistory(`${customMinutes}m`);
}

document.getElementById('timeRangeSelector').addEventListener('change', function () {
    const selectedFilter = this.value;
    loadHistory(selectedFilter);
});
