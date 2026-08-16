import { BrowserRouter, Routes, Route } from 'react-router-dom'
import App from '../App.jsx'
import Landing from './Landing.jsx'
import './landing.css'

// Two routes and nothing else.
//
// "/" is the argument, "/try" is the product. The 3D comparison is unchanged;
// it has simply stopped being the first thing a judge lands on, because the
// comparison only reads as evidence once you know what it is evidence for.

export default function Root() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/try" element={<App />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </BrowserRouter>
  )
}
