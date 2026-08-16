import React from 'react'
import { createRoot } from 'react-dom/client'
import Root from './landing/Root.jsx'
import './index.css'
import './dark.css'
import './three.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
)
